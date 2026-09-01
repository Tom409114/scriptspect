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
    query: 'language:typescript stars:>2000',
    sort: 'stars',
    order: 'desc',
    perPage: 100,
  },
  {
    id: 'javascript',
    query: 'language:javascript stars:>5000',
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
      if (parsed.incomplete_results !== false || !Array.isArray(parsed.items)) {
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
