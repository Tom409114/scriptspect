/** Resolve the ranked corpus candidate snapshot to immutable, root-eligible commits. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CandidateStratum,
  CORPUS_CANDIDATE_STRATA,
  CORPUS_SAMPLE_METHOD,
  type CorpusCandidateSnapshot,
  interleaveCandidateStrata,
  type OrderedCandidate,
} from './corpus-candidates';
import { DEFAULT_CORPUS_LIMITS, redactCorpusText, sha256 } from './corpus-lib';
import {
  type GitHubFailureEvidence,
  githubApiResponse,
  githubFailureEvidence,
  invalidGitHubResponse,
} from './github-api';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const GRAPHQL_BATCH_SIZE = 20;

interface GraphQlError {
  type?: unknown;
  path?: unknown;
  message?: unknown;
}

interface GraphQlRateLimit {
  cost?: unknown;
  limit?: unknown;
  remaining?: unknown;
  used?: unknown;
  resetAt?: unknown;
}

interface GraphQlTreeEntry {
  name?: unknown;
  mode?: unknown;
  type?: unknown;
  oid?: unknown;
  object?: {
    __typename?: unknown;
    oid?: unknown;
    byteSize?: unknown;
    isBinary?: unknown;
  } | null;
}

interface GraphQlRepository {
  nameWithOwner?: unknown;
  defaultBranchRef?: {
    name?: unknown;
    target?: {
      __typename?: unknown;
      oid?: unknown;
      file?: GraphQlTreeEntry | null;
    } | null;
  } | null;
}

interface GraphQlResponse {
  data?: Record<string, unknown> & { rateLimit?: GraphQlRateLimit };
  errors?: GraphQlError[];
}

interface ApiEvidence {
  transport: 'github-graphql-batch-v1';
  batchSize: 20;
  requests: number;
  cost: number;
  rateLimit?: {
    limit: number;
    remaining: number;
    used: number;
    resetAt: string;
  };
}

interface ParsedRateLimit extends NonNullable<ApiEvidence['rateLimit']> {
  cost: number;
}

interface SelectedCandidate extends OrderedCandidate {
  commit: string;
  rootManifestOid: string;
  rootManifestBytes: number;
}

interface CorpusSampleExclusion extends OrderedCandidate {
  commit: string;
  reason: 'root-package-json-unavailable';
}

export interface CorpusSampleEvidence {
  schemaVersion: 2;
  method: typeof CORPUS_SAMPLE_METHOD;
  candidateSnapshotSha256: string;
  requested: number;
  actual: number;
  candidatesConsidered: number;
  status: 'complete' | 'failed';
  api: ApiEvidence;
  selected: SelectedCandidate[];
  exclusions: CorpusSampleExclusion[];
  error?: string;
  failure?: GitHubFailureEvidence;
}

export interface CorpusResolveOptions {
  candidateFile: string;
  outputFile: string;
  evidenceFile: string;
  requested: number;
  token: string;
  fetchImpl?: typeof fetch;
}

function validRepositoryName(value: string): boolean {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))$/.exec(
    value,
  );
  return match !== null && !value.includes('..') && !value.endsWith('.');
}

function exactOid(value: unknown, description: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw invalidGitHubResponse(GRAPHQL_URL, `${description} was not an exact 40-character oid`);
  }
  return value;
}

function safeInteger(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidGitHubResponse(GRAPHQL_URL, `${description} was invalid`);
  }
  return value;
}

function validateStratum(value: unknown, index: number): CandidateStratum {
  if (typeof value !== 'object' || value === null) throw new Error('candidate stratum was invalid');
  const stratum = value as Partial<CandidateStratum>;
  const expected = CORPUS_CANDIDATE_STRATA[index];
  if (
    expected === undefined ||
    stratum.id !== expected.id ||
    stratum.query !== expected.query ||
    stratum.sort !== expected.sort ||
    stratum.order !== expected.order ||
    stratum.perPage !== expected.perPage ||
    typeof stratum.responseSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(stratum.responseSha256) ||
    !Array.isArray(stratum.candidates)
  ) {
    throw new Error('candidate stratum metadata was invalid');
  }
  const candidates = stratum.candidates.map((candidate, index) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      candidate.rank !== index + 1 ||
      typeof candidate.repository !== 'string' ||
      !validRepositoryName(candidate.repository) ||
      typeof candidate.stars !== 'number' ||
      !Number.isSafeInteger(candidate.stars) ||
      candidate.stars < 0
    ) {
      throw new Error(`${stratum.id}: ranked candidate ${index + 1} was invalid`);
    }
    return candidate;
  });
  return { ...stratum, candidates } as CandidateStratum;
}

function readCandidateSnapshot(candidateFile: string): {
  snapshot: CorpusCandidateSnapshot;
  digest: string;
} {
  const bytes = readFileSync(candidateFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('candidate snapshot was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('candidate snapshot was invalid');
  const candidate = parsed as Partial<CorpusCandidateSnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.status !== 'complete' ||
    candidate.method !== CORPUS_SAMPLE_METHOD ||
    !Array.isArray(candidate.strata) ||
    !Array.isArray(candidate.orderedCandidates)
  ) {
    throw new Error('candidate snapshot was incomplete or incompatible');
  }
  if (candidate.strata.length !== CORPUS_CANDIDATE_STRATA.length) {
    throw new Error('candidate snapshot did not contain the required popularity strata');
  }
  const strata = candidate.strata.map(validateStratum);
  if (new Set(strata.map((stratum) => stratum.id)).size !== strata.length) {
    throw new Error('candidate snapshot contained duplicate strata');
  }
  const expected = interleaveCandidateStrata(strata);
  if (JSON.stringify(candidate.orderedCandidates) !== JSON.stringify(expected)) {
    throw new Error('candidate snapshot ordering did not match its ranked strata');
  }
  return {
    snapshot: { ...candidate, strata, orderedCandidates: expected } as CorpusCandidateSnapshot,
    digest: sha256(bytes),
  };
}

function graphQlQuery(candidates: readonly OrderedCandidate[]): string {
  const repositories = candidates.map((candidate, index) => {
    const [owner, name] = candidate.repository.split('/');
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      nameWithOwner
      defaultBranchRef {
        name
        target {
          __typename
          ... on Commit {
            oid
            file(path: "package.json") {
              name
              mode
              type
              oid
              object {
                __typename
                ... on Blob { oid byteSize isBinary }
              }
            }
          }
        }
      }
    }`;
  });
  return `query CorpusEligibility {\n${repositories.join('\n')}\nrateLimit { cost limit remaining used resetAt }\n}`;
}

function expectedMissingRoot(error: GraphQlError, alias: string): boolean {
  return (
    error.type === 'NOT_FOUND' &&
    Array.isArray(error.path) &&
    JSON.stringify(error.path) === JSON.stringify([alias, 'defaultBranchRef', 'target', 'file'])
  );
}

function graphQlRateLimit(value: unknown): ParsedRateLimit {
  if (typeof value !== 'object' || value === null) {
    throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL response had no rateLimit');
  }
  const rate = value as GraphQlRateLimit;
  return {
    cost: safeInteger(rate.cost, 'GitHub GraphQL rateLimit.cost'),
    limit: safeInteger(rate.limit, 'GitHub GraphQL rateLimit.limit'),
    remaining: safeInteger(rate.remaining, 'GitHub GraphQL rateLimit.remaining'),
    used: safeInteger(rate.used, 'GitHub GraphQL rateLimit.used'),
    resetAt:
      typeof rate.resetAt === 'string' && !Number.isNaN(Date.parse(rate.resetAt))
        ? rate.resetAt
        : (() => {
            throw invalidGitHubResponse(
              GRAPHQL_URL,
              'GitHub GraphQL rateLimit.resetAt was invalid',
            );
          })(),
  };
}

function resolveRepository(
  candidate: OrderedCandidate,
  alias: string,
  repository: unknown,
  errors: readonly GraphQlError[],
): SelectedCandidate | CorpusSampleExclusion {
  if (typeof repository !== 'object' || repository === null) {
    throw invalidGitHubResponse(
      GRAPHQL_URL,
      `${candidate.repository}: GitHub GraphQL repository was unavailable`,
    );
  }
  const result = repository as GraphQlRepository;
  if (result.nameWithOwner !== candidate.repository) {
    throw invalidGitHubResponse(
      GRAPHQL_URL,
      `${candidate.repository}: canonical repository name did not match`,
    );
  }
  const target = result.defaultBranchRef?.target;
  if (target?.__typename !== 'Commit') {
    throw invalidGitHubResponse(
      GRAPHQL_URL,
      `${candidate.repository}: default branch did not resolve to a commit`,
    );
  }
  const commit = exactOid(target.oid, `${candidate.repository}: default branch commit`);
  const aliasErrors = errors.filter(
    (error) => Array.isArray(error.path) && error.path[0] === alias,
  );
  if (target.file === null || target.file === undefined) {
    if (aliasErrors.length !== 1 || !expectedMissingRoot(aliasErrors[0] as GraphQlError, alias)) {
      throw invalidGitHubResponse(
        GRAPHQL_URL,
        `${candidate.repository}@${commit}: root package.json was unresolved without the expected NOT_FOUND evidence`,
      );
    }
    return { ...candidate, commit, reason: 'root-package-json-unavailable' };
  }
  if (aliasErrors.length !== 0) {
    throw invalidGitHubResponse(
      GRAPHQL_URL,
      `${candidate.repository}@${commit}: GitHub GraphQL returned a partial error`,
    );
  }
  const file = target.file;
  const oid = exactOid(file.oid, `${candidate.repository}@${commit}: root manifest tree entry`);
  const objectOid = exactOid(
    file.object?.oid,
    `${candidate.repository}@${commit}: root manifest blob`,
  );
  const bytes = safeInteger(
    file.object?.byteSize,
    `${candidate.repository}@${commit}: root manifest byte size`,
  );
  if (
    file.name !== 'package.json' ||
    file.type !== 'blob' ||
    (file.mode !== 33188 && file.mode !== 33261) ||
    file.object?.__typename !== 'Blob' ||
    file.object.isBinary !== false ||
    oid !== objectOid ||
    bytes > DEFAULT_CORPUS_LIMITS.maxFileBytes
  ) {
    throw invalidGitHubResponse(
      GRAPHQL_URL,
      `${candidate.repository}@${commit}: root package.json did not satisfy immutable blob invariants`,
    );
  }
  return { ...candidate, commit, rootManifestOid: oid, rootManifestBytes: bytes };
}

function writeEvidence(
  outputFile: string,
  evidenceFile: string,
  locators: readonly string[],
  evidence: CorpusSampleEvidence,
): void {
  mkdirSync(dirname(resolve(outputFile)), { recursive: true });
  mkdirSync(dirname(resolve(evidenceFile)), { recursive: true });
  writeFileSync(outputFile, locators.length === 0 ? '' : `${locators.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

/** Select exactly `requested` immutable repositories from the audited ranked snapshot. */
export async function resolveCorpusSample(
  options: CorpusResolveOptions,
): Promise<CorpusSampleEvidence> {
  if (options.token === '') throw new Error('GITHUB_TOKEN is required (read-only public access)');
  if (
    !Number.isSafeInteger(options.requested) ||
    options.requested < 1 ||
    options.requested > 100
  ) {
    throw new Error('requested repository count must be an integer from 1 through 100');
  }
  const { snapshot, digest } = readCandidateSnapshot(options.candidateFile);
  if (snapshot.orderedCandidates.length < options.requested) {
    throw new Error(
      `requested ${options.requested} repositories but only ${snapshot.orderedCandidates.length} ordered candidates were captured`,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const selected: SelectedCandidate[] = [];
  const exclusions: CorpusSampleExclusion[] = [];
  const api: ApiEvidence = {
    transport: 'github-graphql-batch-v1',
    batchSize: GRAPHQL_BATCH_SIZE,
    requests: 0,
    cost: 0,
  };
  let candidatesConsidered = 0;
  let lastApiResponse: Response | undefined;

  try {
    for (let offset = 0; offset < snapshot.orderedCandidates.length; offset += GRAPHQL_BATCH_SIZE) {
      const batch = snapshot.orderedCandidates.slice(offset, offset + GRAPHQL_BATCH_SIZE);
      const response = await githubApiResponse(
        fetchImpl,
        GRAPHQL_URL,
        options.token,
        'scriptspect-corpus-resolve',
        { method: 'POST', body: JSON.stringify({ query: graphQlQuery(batch) }) },
      );
      lastApiResponse = response;
      api.requests += 1;
      let payload: GraphQlResponse;
      try {
        payload = (await response.json()) as GraphQlResponse;
      } catch {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL response was not valid JSON');
      }
      if (typeof payload.data !== 'object' || payload.data === null) {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL response had no data');
      }
      const errors = payload.errors ?? [];
      if (!Array.isArray(errors)) {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL errors were invalid');
      }
      const unrelatedError = errors.find(
        (error) =>
          typeof error !== 'object' ||
          error === null ||
          !batch.some((_, index) => expectedMissingRoot(error, `r${index}`)),
      );
      if (unrelatedError !== undefined) {
        throw invalidGitHubResponse(
          GRAPHQL_URL,
          'GitHub GraphQL returned an unexpected partial error',
        );
      }
      const rate = graphQlRateLimit(payload.data.rateLimit);
      api.cost += rate.cost;
      api.rateLimit = {
        limit: rate.limit,
        remaining: rate.remaining,
        used: rate.used,
        resetAt: rate.resetAt,
      };

      for (const [index, candidate] of batch.entries()) {
        candidatesConsidered += 1;
        const resolved = resolveRepository(
          candidate,
          `r${index}`,
          payload.data[`r${index}`],
          errors,
        );
        if ('reason' in resolved) exclusions.push(resolved);
        else selected.push(resolved);
        if (selected.length === options.requested) break;
      }
      if (selected.length === options.requested) break;
      if (rate.remaining === 0) {
        throw invalidGitHubResponse(
          GRAPHQL_URL,
          `GitHub GraphQL primary budget was exhausted before ${options.requested} repositories resolved`,
        );
      }
    }
    if (selected.length !== options.requested) {
      throw new Error(
        `requested ${options.requested} root-eligible repositories but only ${selected.length} were resolved`,
      );
    }
  } catch (error) {
    const originalFailure = githubFailureEvidence(error);
    const recordedError =
      originalFailure?.kind === 'response-invalid' &&
      originalFailure.status === null &&
      lastApiResponse !== undefined
        ? invalidGitHubResponse(
            GRAPHQL_URL,
            error instanceof Error ? error.message : String(error),
            lastApiResponse,
          )
        : error;
    const message = redactCorpusText(
      recordedError instanceof Error ? recordedError.message : String(recordedError),
    );
    const failure = githubFailureEvidence(recordedError);
    const failed: CorpusSampleEvidence = {
      schemaVersion: 2,
      method: CORPUS_SAMPLE_METHOD,
      candidateSnapshotSha256: digest,
      requested: options.requested,
      actual: selected.length,
      candidatesConsidered,
      status: 'failed',
      api,
      selected,
      exclusions,
      error: message,
      ...(failure === undefined ? {} : { failure }),
    };
    writeEvidence(
      options.outputFile,
      options.evidenceFile,
      selected.map((candidate) => `${candidate.repository}@${candidate.commit}`),
      failed,
    );
    throw new Error(message);
  }

  const complete: CorpusSampleEvidence = {
    schemaVersion: 2,
    method: CORPUS_SAMPLE_METHOD,
    candidateSnapshotSha256: digest,
    requested: options.requested,
    actual: selected.length,
    candidatesConsidered,
    status: 'complete',
    api,
    selected,
    exclusions,
  };
  writeEvidence(
    options.outputFile,
    options.evidenceFile,
    selected.map((candidate) => `${candidate.repository}@${candidate.commit}`),
    complete,
  );
  return complete;
}

async function main(): Promise<void> {
  const [candidateFile, outputFile, evidenceFile, requestedText] = process.argv.slice(2);
  if (
    candidateFile === undefined ||
    outputFile === undefined ||
    evidenceFile === undefined ||
    requestedText === undefined
  ) {
    throw new Error(
      'usage: tsx tools/corpus-resolve.ts repository-candidates.json repos.txt repository-sample.json count',
    );
  }
  await resolveCorpusSample({
    candidateFile,
    outputFile,
    evidenceFile,
    requested: Number(requestedText),
    token: process.env.GITHUB_TOKEN ?? '',
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(
      `scriptspect corpus resolver: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
