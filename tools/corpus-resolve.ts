/** Resolve the ranked corpus candidate snapshot to immutable, root-eligible commits. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_SAMPLE_METHOD,
  MAX_CORPUS_REPOSITORIES,
  type OrderedCandidate,
  parseCorpusCandidateSnapshot,
} from './corpus-candidates';
import { DEFAULT_CORPUS_LIMITS, redactCorpusText } from './corpus-lib';
import {
  classifiedGitHubError,
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

function classifiedGraphQlFailure(
  errors: readonly GraphQlError[],
  response: Response,
):
  | {
      kind:
        | 'primary-rate-limit-exhausted'
        | 'secondary-rate-limit'
        | 'authentication-failed'
        | 'permission-denied';
      type: 'RATE_LIMITED' | 'UNAUTHORIZED' | 'FORBIDDEN';
    }
  | undefined {
  for (const error of errors) {
    if (error.type === 'RATE_LIMITED') {
      return {
        kind:
          response.headers.get('x-ratelimit-remaining') === '0'
            ? 'primary-rate-limit-exhausted'
            : 'secondary-rate-limit',
        type: error.type,
      };
    }
    if (error.type === 'UNAUTHORIZED') {
      return { kind: 'authentication-failed', type: error.type };
    }
    if (error.type === 'FORBIDDEN') {
      return { kind: 'permission-denied', type: error.type };
    }
  }
  return undefined;
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
    options.requested > MAX_CORPUS_REPOSITORIES
  ) {
    throw new Error(
      `requested repository count must be an integer from 1 through ${MAX_CORPUS_REPOSITORIES}`,
    );
  }
  const { snapshot, digest } = parseCorpusCandidateSnapshot(readFileSync(options.candidateFile));
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
      api.requests += 1;
      const response = await githubApiResponse(
        fetchImpl,
        GRAPHQL_URL,
        options.token,
        'scriptspect-corpus-resolve',
        { method: 'POST', body: JSON.stringify({ query: graphQlQuery(batch) }) },
      );
      lastApiResponse = response;
      let payload: GraphQlResponse;
      try {
        payload = (await response.json()) as GraphQlResponse;
      } catch {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL response was not valid JSON');
      }
      const errors = payload.errors ?? [];
      if (!Array.isArray(errors)) {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL errors were invalid');
      }
      const classifiedFailure = classifiedGraphQlFailure(errors, response);
      if (classifiedFailure !== undefined) {
        throw classifiedGitHubError(
          classifiedFailure.kind,
          GRAPHQL_URL,
          `GitHub GraphQL returned ${classifiedFailure.type}`,
          response,
        );
      }
      if (typeof payload.data !== 'object' || payload.data === null) {
        throw invalidGitHubResponse(GRAPHQL_URL, 'GitHub GraphQL response had no data');
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
