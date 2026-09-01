/** Collect and persist the complete ranked candidate universe for corpus selection. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactCorpusText, sha256 } from './corpus-lib';
import {
  type GitHubFailureEvidence,
  githubApiResponse,
  githubFailureEvidence,
  invalidGitHubResponse,
} from './github-api';

const GITHUB_API = 'https://api.github.com';
export const CORPUS_SAMPLE_METHOD = 'popularity-strata-round-robin-v1' as const;

interface SearchItem {
  full_name?: string;
  stargazers_count?: number;
}

interface SearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: SearchItem[];
}

export interface RankedCandidate {
  rank: number;
  repository: string;
  stars: number;
}

export interface CandidateStratum {
  id: 'typescript' | 'javascript';
  query: string;
  sort: 'stars';
  order: 'desc';
  perPage: 100;
  responseSha256: string;
  candidates: RankedCandidate[];
}

export interface OrderedCandidate {
  position: number;
  stratum: CandidateStratum['id'];
  rank: number;
  repository: string;
}

export interface CorpusCandidateSnapshot {
  schemaVersion: 1;
  status: 'complete' | 'failed';
  method: typeof CORPUS_SAMPLE_METHOD;
  strata: CandidateStratum[];
  orderedCandidates: OrderedCandidate[];
  error?: string;
  failure?: GitHubFailureEvidence;
}

export interface CollectCorpusCandidatesOptions {
  outputFile: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export const CORPUS_CANDIDATE_STRATA: ReadonlyArray<
  Pick<CandidateStratum, 'id' | 'query' | 'sort' | 'order' | 'perPage'>
> = [
  {
    id: 'typescript',
    query: 'is:public language:typescript stars:>2000',
    sort: 'stars',
    order: 'desc',
    perPage: 100,
  },
  {
    id: 'javascript',
    query: 'is:public language:javascript stars:>5000',
    sort: 'stars',
    order: 'desc',
    perPage: 100,
  },
];

function validRepositoryName(value: string): boolean {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.')
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateRankedCandidate(
  value: unknown,
  index: number,
  stratumId: CandidateStratum['id'],
): RankedCandidate {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ['rank', 'repository', 'stars'])
  ) {
    throw new Error(`candidate snapshot ${stratumId}: ranked candidate ${index + 1} was invalid`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.rank !== index + 1 ||
    typeof candidate.repository !== 'string' ||
    !validRepositoryName(candidate.repository) ||
    typeof candidate.stars !== 'number' ||
    !Number.isSafeInteger(candidate.stars) ||
    candidate.stars < 0
  ) {
    throw new Error(`candidate snapshot ${stratumId}: ranked candidate ${index + 1} was invalid`);
  }
  return {
    rank: candidate.rank,
    repository: candidate.repository,
    stars: candidate.stars,
  };
}

function validateCandidateStratum(value: unknown, index: number): CandidateStratum {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      'id',
      'query',
      'sort',
      'order',
      'perPage',
      'responseSha256',
      'candidates',
    ])
  ) {
    throw new Error('candidate snapshot stratum metadata was invalid');
  }
  const stratum = value as Record<string, unknown>;
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
    throw new Error('candidate snapshot stratum metadata was invalid');
  }
  if (stratum.candidates.length > 100) {
    throw new Error(`candidate snapshot ${expected.id}: candidate stratum exceeded 100 candidates`);
  }
  const candidates = stratum.candidates.map((candidate, candidateIndex) =>
    validateRankedCandidate(candidate, candidateIndex, expected.id),
  );
  if (
    candidates.some((candidate, candidateIndex) => {
      const previous = candidates[candidateIndex - 1];
      return previous !== undefined && candidate.stars > previous.stars;
    })
  ) {
    throw new Error(
      `candidate snapshot ${expected.id}: ranked candidates were not non-increasing by stars`,
    );
  }
  if (new Set(candidates.map((candidate) => candidate.repository)).size !== candidates.length) {
    throw new Error(`candidate snapshot ${expected.id}: ranked candidates contained duplicates`);
  }
  return { ...expected, responseSha256: stratum.responseSha256, candidates };
}

/** Parse and fully validate the durable Search snapshot before any downstream API use. */
export function parseCorpusCandidateSnapshot(bytes: Buffer): {
  snapshot: CorpusCandidateSnapshot;
  digest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('candidate snapshot was not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, [
      'schemaVersion',
      'status',
      'method',
      'strata',
      'orderedCandidates',
    ])
  ) {
    throw new Error('candidate snapshot was incomplete or incompatible');
  }
  const candidate = parsed as Record<string, unknown>;
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
  const rawCandidateCount = candidate.strata.reduce((total, value) => {
    if (typeof value !== 'object' || value === null || !Array.isArray(value.candidates)) {
      return total;
    }
    return total + value.candidates.length;
  }, 0);
  if (rawCandidateCount > 200) {
    throw new Error('candidate snapshot Search candidate budget exceeded 200');
  }
  const strata = candidate.strata.map(validateCandidateStratum);
  const expectedOrder = interleaveCandidateStrata(strata);
  const orderedCandidates = candidate.orderedCandidates.map((value, index): OrderedCandidate => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ['position', 'stratum', 'rank', 'repository'])
    ) {
      throw new Error('candidate snapshot ordering did not match its ranked strata');
    }
    const ordered = value as Record<string, unknown>;
    const expected = expectedOrder[index];
    if (
      expected === undefined ||
      ordered.position !== expected.position ||
      ordered.stratum !== expected.stratum ||
      ordered.rank !== expected.rank ||
      ordered.repository !== expected.repository
    ) {
      throw new Error('candidate snapshot ordering did not match its ranked strata');
    }
    return expected;
  });
  if (orderedCandidates.length !== expectedOrder.length) {
    throw new Error('candidate snapshot ordering did not match its ranked strata');
  }
  return {
    snapshot: {
      schemaVersion: 1,
      status: 'complete',
      method: CORPUS_SAMPLE_METHOD,
      strata,
      orderedCandidates,
    },
    digest: sha256(bytes),
  };
}

export function interleaveCandidateStrata(strata: readonly CandidateStratum[]): OrderedCandidate[] {
  const seen = new Set<string>();
  const ordered: OrderedCandidate[] = [];
  const maxRank = Math.max(0, ...strata.map((stratum) => stratum.candidates.length));
  for (let offset = 0; offset < maxRank; offset += 1) {
    for (const stratum of strata) {
      const candidate = stratum.candidates[offset];
      if (candidate === undefined || seen.has(candidate.repository)) continue;
      seen.add(candidate.repository);
      ordered.push({
        position: ordered.length + 1,
        stratum: stratum.id,
        rank: candidate.rank,
        repository: candidate.repository,
      });
    }
  }
  return ordered;
}

function writeSnapshot(outputFile: string, snapshot: CorpusCandidateSnapshot): void {
  mkdirSync(dirname(resolve(outputFile)), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function searchUrl(stratum: (typeof CORPUS_CANDIDATE_STRATA)[number]): string {
  const url = new URL(`${GITHUB_API}/search/repositories`);
  url.searchParams.set('q', stratum.query);
  url.searchParams.set('sort', stratum.sort);
  url.searchParams.set('order', stratum.order);
  url.searchParams.set('per_page', String(stratum.perPage));
  return url.href;
}

export async function collectCorpusCandidates(
  options: CollectCorpusCandidatesOptions,
): Promise<CorpusCandidateSnapshot> {
  if (options.token === '') throw new Error('GITHUB_TOKEN is required (read-only public access)');
  const fetchImpl = options.fetchImpl ?? fetch;
  const strata: CandidateStratum[] = [];
  try {
    for (const definition of CORPUS_CANDIDATE_STRATA) {
      const url = searchUrl(definition);
      const response = await githubApiResponse(
        fetchImpl,
        url,
        options.token,
        'scriptspect-corpus-candidates',
      );
      const responseText = await response.text();
      let parsed: SearchResponse;
      try {
        parsed = JSON.parse(responseText) as SearchResponse;
      } catch {
        throw invalidGitHubResponse(
          url,
          `${definition.id}: GitHub search response was not JSON`,
          response,
        );
      }
      if (
        parsed.incomplete_results !== false ||
        typeof parsed.total_count !== 'number' ||
        !Number.isSafeInteger(parsed.total_count) ||
        parsed.total_count < 0 ||
        !Array.isArray(parsed.items) ||
        parsed.items.length !== Math.min(parsed.total_count, definition.perPage)
      ) {
        throw invalidGitHubResponse(
          url,
          `${definition.id}: GitHub search response was incomplete or invalid`,
          response,
        );
      }
      const candidates = parsed.items.map((item, index): RankedCandidate => {
        if (
          typeof item.full_name !== 'string' ||
          !validRepositoryName(item.full_name) ||
          typeof item.stargazers_count !== 'number' ||
          !Number.isSafeInteger(item.stargazers_count) ||
          item.stargazers_count < 0
        ) {
          throw invalidGitHubResponse(
            url,
            `${definition.id}: GitHub search candidate was invalid`,
            response,
          );
        }
        return { rank: index + 1, repository: item.full_name, stars: item.stargazers_count };
      });
      if (
        candidates.some((candidate, index) => {
          const previous = candidates[index - 1];
          return previous !== undefined && candidate.stars > previous.stars;
        })
      ) {
        throw invalidGitHubResponse(
          url,
          `${definition.id}: GitHub search candidates were not ranked by stars`,
          response,
        );
      }
      strata.push({ ...definition, responseSha256: sha256(responseText), candidates });
    }
    const snapshot: CorpusCandidateSnapshot = {
      schemaVersion: 1,
      status: 'complete',
      method: CORPUS_SAMPLE_METHOD,
      strata,
      orderedCandidates: interleaveCandidateStrata(strata),
    };
    writeSnapshot(options.outputFile, snapshot);
    return snapshot;
  } catch (error) {
    const message = redactCorpusText(error instanceof Error ? error.message : String(error));
    const snapshot: CorpusCandidateSnapshot = {
      schemaVersion: 1,
      status: 'failed',
      method: CORPUS_SAMPLE_METHOD,
      strata,
      orderedCandidates: interleaveCandidateStrata(strata),
      error: message,
      ...(githubFailureEvidence(error) === undefined
        ? {}
        : { failure: githubFailureEvidence(error) }),
    };
    writeSnapshot(options.outputFile, snapshot);
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const outputFile = process.argv[2];
  if (outputFile === undefined) {
    throw new Error('usage: tsx tools/corpus-candidates.ts repository-candidates.json');
  }
  await collectCorpusCandidates({
    outputFile,
    token: process.env.GITHUB_TOKEN ?? '',
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(
      `scriptspect corpus candidates: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
