/** Collect and persist the complete ranked candidate universe for corpus selection. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactCorpusText, sha256 } from './corpus-lib';
import {
  classifiedGitHubError,
  type GitHubFailureEvidence,
  githubApiResponse,
  githubFailureEvidence,
  invalidGitHubResponse,
} from './github-api';

const GITHUB_API = 'https://api.github.com';
const GITHUB_SEARCH_PER_PAGE = 100;
const GITHUB_SEARCH_RESULT_CEILING = 1000;
export const MAX_CORPUS_REPOSITORIES = 1000;
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
  totalCount?: number;
  responseSha256: string;
  pages?: CandidateSearchPage[];
  candidates: RankedCandidate[];
}

export interface CandidateSearchPage {
  page: number;
  itemCount: number;
  responseSha256: string;
}

export interface CandidateSearchApiEvidence {
  transport: 'github-search-rest-v1';
  perPage: 100;
  resultCeiling: 1000;
  requests: number;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: number;
    used: number;
    resource: 'search';
  };
}

export interface OrderedCandidate {
  position: number;
  stratum: CandidateStratum['id'];
  rank: number;
  repository: string;
}

export interface CorpusCandidateSnapshot {
  schemaVersion: 1 | 2;
  status: 'complete' | 'failed';
  method: typeof CORPUS_SAMPLE_METHOD;
  candidateTargetPerStratum?: number;
  api?: CandidateSearchApiEvidence;
  strata: CandidateStratum[];
  orderedCandidates: OrderedCandidate[];
  error?: string;
  failure?: GitHubFailureEvidence;
}

export interface CollectCorpusCandidatesOptions {
  outputFile: string;
  token: string;
  requested?: number;
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
    perPage: GITHUB_SEARCH_PER_PAGE,
  },
  {
    id: 'javascript',
    query: 'is:public language:javascript stars:>5000',
    sort: 'stars',
    order: 'desc',
    perPage: GITHUB_SEARCH_PER_PAGE,
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

function validateCandidateSearchPage(value: unknown, index: number): CandidateSearchPage {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ['page', 'itemCount', 'responseSha256'])
  ) {
    throw new Error('candidate snapshot Search page evidence was invalid');
  }
  const page = value as Record<string, unknown>;
  if (
    page.page !== index + 1 ||
    typeof page.itemCount !== 'number' ||
    !Number.isSafeInteger(page.itemCount) ||
    page.itemCount < 0 ||
    page.itemCount > GITHUB_SEARCH_PER_PAGE ||
    typeof page.responseSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(page.responseSha256)
  ) {
    throw new Error('candidate snapshot Search page evidence was invalid');
  }
  return {
    page: page.page,
    itemCount: page.itemCount,
    responseSha256: page.responseSha256,
  };
}

function aggregatePageDigest(pages: readonly CandidateSearchPage[]): string {
  return sha256(
    pages.map((page) => `${page.page}:${page.itemCount}:${page.responseSha256}`).join('\n'),
  );
}

function validateCandidateStratum(
  value: unknown,
  index: number,
  schemaVersion: 1 | 2,
  candidateTargetPerStratum: number,
): CandidateStratum {
  const keys =
    schemaVersion === 1
      ? ['id', 'query', 'sort', 'order', 'perPage', 'responseSha256', 'candidates']
      : [
          'id',
          'query',
          'sort',
          'order',
          'perPage',
          'totalCount',
          'responseSha256',
          'pages',
          'candidates',
        ];
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, keys)
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
  const stratumLimit = schemaVersion === 1 ? 100 : GITHUB_SEARCH_RESULT_CEILING;
  if (stratum.candidates.length > stratumLimit) {
    throw new Error(
      `candidate snapshot ${expected.id}: candidate stratum exceeded ${stratumLimit} candidates`,
    );
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
  if (schemaVersion === 1) {
    return { ...expected, responseSha256: stratum.responseSha256, candidates };
  }
  if (
    typeof stratum.totalCount !== 'number' ||
    !Number.isSafeInteger(stratum.totalCount) ||
    stratum.totalCount < 0 ||
    !Array.isArray(stratum.pages)
  ) {
    throw new Error(`candidate snapshot ${expected.id}: Search pagination was invalid`);
  }
  const pages = stratum.pages.map(validateCandidateSearchPage);
  const expectedCandidateCount = Math.min(
    stratum.totalCount,
    candidateTargetPerStratum,
    GITHUB_SEARCH_RESULT_CEILING,
  );
  const expectedPageCount = Math.max(1, Math.ceil(expectedCandidateCount / expected.perPage));
  if (
    candidates.length !== expectedCandidateCount ||
    pages.length !== expectedPageCount ||
    pages.some((page, pageIndex) => {
      const searchableCount = Math.min(stratum.totalCount as number, GITHUB_SEARCH_RESULT_CEILING);
      const remaining = Math.max(0, searchableCount - pageIndex * expected.perPage);
      return page.itemCount !== Math.min(expected.perPage, remaining);
    }) ||
    stratum.responseSha256 !== aggregatePageDigest(pages)
  ) {
    throw new Error(`candidate snapshot ${expected.id}: Search pagination was invalid`);
  }
  return {
    ...expected,
    totalCount: stratum.totalCount,
    responseSha256: stratum.responseSha256,
    pages,
    candidates,
  };
}

function validateCandidateApi(
  value: unknown,
  expectedRequests: number,
): CandidateSearchApiEvidence {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      'transport',
      'perPage',
      'resultCeiling',
      'requests',
      'rateLimit',
    ])
  ) {
    throw new Error('candidate snapshot Search API evidence was invalid');
  }
  const api = value as Record<string, unknown>;
  if (
    api.transport !== 'github-search-rest-v1' ||
    api.perPage !== GITHUB_SEARCH_PER_PAGE ||
    api.resultCeiling !== GITHUB_SEARCH_RESULT_CEILING ||
    api.requests !== expectedRequests ||
    typeof api.rateLimit !== 'object' ||
    api.rateLimit === null ||
    Array.isArray(api.rateLimit) ||
    !exactKeys(api.rateLimit as Record<string, unknown>, [
      'limit',
      'remaining',
      'reset',
      'used',
      'resource',
    ])
  ) {
    throw new Error('candidate snapshot Search API evidence was invalid');
  }
  const rateLimit = api.rateLimit as Record<string, unknown>;
  for (const key of ['limit', 'remaining', 'reset', 'used'] as const) {
    if (
      typeof rateLimit[key] !== 'number' ||
      !Number.isSafeInteger(rateLimit[key]) ||
      rateLimit[key] < (key === 'limit' || key === 'reset' ? 1 : 0)
    ) {
      throw new Error('candidate snapshot Search API evidence was invalid');
    }
  }
  if (
    rateLimit.resource !== 'search' ||
    Number(rateLimit.remaining) > Number(rateLimit.limit) ||
    Number(rateLimit.used) > Number(rateLimit.limit)
  ) {
    throw new Error('candidate snapshot Search API evidence was invalid');
  }
  return {
    transport: 'github-search-rest-v1',
    perPage: GITHUB_SEARCH_PER_PAGE,
    resultCeiling: GITHUB_SEARCH_RESULT_CEILING,
    requests: expectedRequests,
    rateLimit: {
      limit: Number(rateLimit.limit),
      remaining: Number(rateLimit.remaining),
      reset: Number(rateLimit.reset),
      used: Number(rateLimit.used),
      resource: 'search',
    },
  };
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
    ((parsed as Record<string, unknown>).schemaVersion !== 1 &&
      (parsed as Record<string, unknown>).schemaVersion !== 2)
  ) {
    throw new Error('candidate snapshot was incomplete or incompatible');
  }
  const candidate = parsed as Record<string, unknown>;
  const schemaVersion = candidate.schemaVersion as 1 | 2;
  const rootKeys =
    schemaVersion === 1
      ? ['schemaVersion', 'status', 'method', 'strata', 'orderedCandidates']
      : [
          'schemaVersion',
          'status',
          'method',
          'candidateTargetPerStratum',
          'api',
          'strata',
          'orderedCandidates',
        ];
  if (
    !exactKeys(candidate, rootKeys) ||
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
  const candidateTargetPerStratum = schemaVersion === 1 ? 100 : candidate.candidateTargetPerStratum;
  if (
    typeof candidateTargetPerStratum !== 'number' ||
    !Number.isSafeInteger(candidateTargetPerStratum) ||
    candidateTargetPerStratum < 1 ||
    candidateTargetPerStratum > MAX_CORPUS_REPOSITORIES
  ) {
    throw new Error('candidate snapshot candidate target was invalid');
  }
  const rawCandidateBudget = schemaVersion === 1 ? 200 : GITHUB_SEARCH_RESULT_CEILING * 2;
  if (rawCandidateCount > rawCandidateBudget) {
    throw new Error(`candidate snapshot Search candidate budget exceeded ${rawCandidateBudget}`);
  }
  const strata = candidate.strata.map((stratum, index) =>
    validateCandidateStratum(stratum, index, schemaVersion, candidateTargetPerStratum),
  );
  const api =
    schemaVersion === 1
      ? undefined
      : validateCandidateApi(
          candidate.api,
          strata.reduce((total, stratum) => total + (stratum.pages?.length ?? 0), 0),
        );
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
      schemaVersion,
      status: 'complete',
      method: CORPUS_SAMPLE_METHOD,
      ...(schemaVersion === 1
        ? {}
        : { candidateTargetPerStratum, api: api as CandidateSearchApiEvidence }),
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

function searchUrl(stratum: (typeof CORPUS_CANDIDATE_STRATA)[number], page: number): string {
  const url = new URL(`${GITHUB_API}/search/repositories`);
  url.searchParams.set('q', stratum.query);
  url.searchParams.set('sort', stratum.sort);
  url.searchParams.set('order', stratum.order);
  url.searchParams.set('per_page', String(stratum.perPage));
  url.searchParams.set('page', String(page));
  return url.href;
}

function responseIntegerHeader(response: Response, name: string, minimum: number): number {
  const raw = response.headers.get(name);
  const value = raw !== null && /^(?:0|[1-9]\d*)$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidGitHubResponse(
      response.url || GITHUB_API,
      `GitHub Search response ${name} header was invalid`,
      response,
    );
  }
  return value;
}

function searchRateLimit(response: Response): NonNullable<CandidateSearchApiEvidence['rateLimit']> {
  const resource = response.headers.get('x-ratelimit-resource');
  const rateLimit = {
    limit: responseIntegerHeader(response, 'x-ratelimit-limit', 1),
    remaining: responseIntegerHeader(response, 'x-ratelimit-remaining', 0),
    reset: responseIntegerHeader(response, 'x-ratelimit-reset', 1),
    used: responseIntegerHeader(response, 'x-ratelimit-used', 0),
    resource,
  };
  if (
    resource !== 'search' ||
    rateLimit.remaining > rateLimit.limit ||
    rateLimit.used > rateLimit.limit
  ) {
    throw invalidGitHubResponse(
      response.url || GITHUB_API,
      'GitHub Search response rate-limit evidence was invalid',
      response,
    );
  }
  return { ...rateLimit, resource };
}

function requestedCandidateTarget(value: number | undefined): number {
  const requested = value ?? 100;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_CORPUS_REPOSITORIES) {
    throw new Error(
      `requested repository count must be an integer from 1 through ${MAX_CORPUS_REPOSITORIES}`,
    );
  }
  return requested;
}

export async function collectCorpusCandidates(
  options: CollectCorpusCandidatesOptions,
): Promise<CorpusCandidateSnapshot> {
  const candidateTargetPerStratum = requestedCandidateTarget(options.requested);
  if (options.token === '') throw new Error('GITHUB_TOKEN is required (read-only public access)');
  const fetchImpl = options.fetchImpl ?? fetch;
  const strata: CandidateStratum[] = [];
  const api: CandidateSearchApiEvidence = {
    transport: 'github-search-rest-v1',
    perPage: GITHUB_SEARCH_PER_PAGE,
    resultCeiling: GITHUB_SEARCH_RESULT_CEILING,
    requests: 0,
  };
  try {
    for (const definition of CORPUS_CANDIDATE_STRATA) {
      const candidates: RankedCandidate[] = [];
      const pages: CandidateSearchPage[] = [];
      const seenResponseRepositories = new Set<string>();
      let totalCount: number | undefined;
      for (let page = 1; page <= GITHUB_SEARCH_RESULT_CEILING / definition.perPage; page += 1) {
        const url = searchUrl(definition, page);
        api.requests += 1;
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
          (totalCount !== undefined && parsed.total_count !== totalCount) ||
          !Array.isArray(parsed.items)
        ) {
          throw invalidGitHubResponse(
            url,
            `${definition.id}: GitHub search response was incomplete or invalid`,
            response,
          );
        }
        totalCount = parsed.total_count;
        const searchableCount = Math.min(totalCount, GITHUB_SEARCH_RESULT_CEILING);
        const accessibleCount = Math.min(searchableCount, candidateTargetPerStratum);
        const pageOffset = (page - 1) * definition.perPage;
        const expectedItems = Math.min(
          definition.perPage,
          Math.max(0, searchableCount - pageOffset),
        );
        if (parsed.items.length !== expectedItems) {
          throw invalidGitHubResponse(
            url,
            `${definition.id}: GitHub search response was incomplete or invalid`,
            response,
          );
        }
        const pageCandidates = parsed.items.map((item, index): RankedCandidate => {
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
          return {
            rank: pageOffset + index + 1,
            repository: item.full_name,
            stars: item.stargazers_count,
          };
        });
        if (
          pageCandidates.some((candidate, index) => {
            const previous = index === 0 ? candidates.at(-1) : pageCandidates[index - 1];
            return previous !== undefined && candidate.stars > previous.stars;
          })
        ) {
          throw invalidGitHubResponse(
            url,
            `${definition.id}: GitHub search candidates were not ranked by stars`,
            response,
          );
        }
        if (
          pageCandidates.some((candidate) => {
            if (seenResponseRepositories.has(candidate.repository)) return true;
            seenResponseRepositories.add(candidate.repository);
            return false;
          })
        ) {
          throw invalidGitHubResponse(
            url,
            `${definition.id}: GitHub search candidates contained duplicates`,
            response,
          );
        }
        candidates.push(...pageCandidates.slice(0, accessibleCount - candidates.length));
        pages.push({
          page,
          itemCount: pageCandidates.length,
          responseSha256: sha256(responseText),
        });
        api.rateLimit = searchRateLimit(response);
        if (candidates.length === accessibleCount) break;
        if (api.rateLimit.remaining === 0) {
          throw classifiedGitHubError(
            'primary-rate-limit-exhausted',
            url,
            `${definition.id}: GitHub Search primary budget was exhausted before the candidate target was captured`,
            response,
          );
        }
      }
      if (
        candidates.some((candidate, index) => {
          const previous = candidates[index - 1];
          return previous !== undefined && candidate.stars > previous.stars;
        })
      ) {
        throw invalidGitHubResponse(
          `${GITHUB_API}/search/repositories`,
          `${definition.id}: GitHub search candidates were not ranked by stars`,
        );
      }
      if (new Set(candidates.map((candidate) => candidate.repository)).size !== candidates.length) {
        throw invalidGitHubResponse(
          `${GITHUB_API}/search/repositories`,
          `${definition.id}: GitHub search candidates contained duplicates`,
        );
      }
      if (totalCount === undefined) throw new Error(`${definition.id}: Search was not attempted`);
      strata.push({
        ...definition,
        totalCount,
        responseSha256: aggregatePageDigest(pages),
        pages,
        candidates,
      });
    }
    const snapshot: CorpusCandidateSnapshot = {
      schemaVersion: 2,
      status: 'complete',
      method: CORPUS_SAMPLE_METHOD,
      candidateTargetPerStratum,
      api,
      strata,
      orderedCandidates: interleaveCandidateStrata(strata),
    };
    writeSnapshot(options.outputFile, snapshot);
    return snapshot;
  } catch (error) {
    const message = redactCorpusText(error instanceof Error ? error.message : String(error));
    const snapshot: CorpusCandidateSnapshot = {
      schemaVersion: 2,
      status: 'failed',
      method: CORPUS_SAMPLE_METHOD,
      candidateTargetPerStratum,
      api,
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
  const [outputFile, requestedText] = process.argv.slice(2);
  if (outputFile === undefined) {
    throw new Error('usage: tsx tools/corpus-candidates.ts repository-candidates.json [count]');
  }
  await collectCorpusCandidates({
    outputFile,
    requested: requestedText === undefined ? 100 : Number(requestedText),
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
