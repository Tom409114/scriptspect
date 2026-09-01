import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

type Collector = (options: {
  outputFile: string;
  token: string;
  fetchImpl: typeof fetch;
}) => Promise<unknown>;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-corpus-candidates-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function collector(): Promise<Collector> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'corpus-candidates.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    collectCorpusCandidates?: Collector;
  };
  expect(typeof module.collectCorpusCandidates).toBe('function');
  if (module.collectCorpusCandidates === undefined) {
    throw new Error('corpus candidate collector was unavailable');
  }
  return module.collectCorpusCandidates;
}

function searchApi(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('q');
    expect(query).toContain('is:public');
    const items = query?.includes('language:typescript')
      ? [
          { full_name: 'alpha/shared', stargazers_count: 100 },
          { full_name: 'gamma/typescript', stargazers_count: 90 },
        ]
      : [
          { full_name: 'beta/javascript', stargazers_count: 110 },
          { full_name: 'alpha/shared', stargazers_count: 100 },
        ];
    return Response.json(
      { total_count: items.length, incomplete_results: false, items },
      {
        headers: {
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '28',
          'x-ratelimit-reset': '1788220800',
          'x-ratelimit-used': '2',
          'x-ratelimit-resource': 'search',
          'x-github-request-id': 'SEARCH:TEST',
        },
      },
    );
  }) as typeof fetch;
}

function invalidSearchApi(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as typeof fetch;
}

it('persists both ranked strata and a deterministic round-robin candidate universe', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');

  await (await collector())({
    outputFile,
    token: 'read-only-test-token',
    fetchImpl: searchApi(),
  });

  const snapshot = JSON.parse(readFileSync(outputFile, 'utf8')) as Record<string, unknown>;
  expect(snapshot).toMatchObject({
    schemaVersion: 1,
    status: 'complete',
    method: 'popularity-strata-round-robin-v1',
    strata: [
      {
        id: 'typescript',
        query: 'is:public language:typescript stars:>2000',
        sort: 'stars',
        order: 'desc',
        perPage: 100,
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidates: [
          { rank: 1, repository: 'alpha/shared', stars: 100 },
          { rank: 2, repository: 'gamma/typescript', stars: 90 },
        ],
      },
      {
        id: 'javascript',
        query: 'is:public language:javascript stars:>5000',
        sort: 'stars',
        order: 'desc',
        perPage: 100,
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidates: [
          { rank: 1, repository: 'beta/javascript', stars: 110 },
          { rank: 2, repository: 'alpha/shared', stars: 100 },
        ],
      },
    ],
    orderedCandidates: [
      { position: 1, stratum: 'typescript', rank: 1, repository: 'alpha/shared' },
      { position: 2, stratum: 'javascript', rank: 1, repository: 'beta/javascript' },
      { position: 3, stratum: 'typescript', rank: 2, repository: 'gamma/typescript' },
    ],
  });
});

it('persists rate-limit headers without leaking the request token', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');
  const headers = {
    'x-ratelimit-limit': '30',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1788224400',
    'x-ratelimit-used': '30',
    'x-ratelimit-resource': 'search',
    'retry-after': '60',
    'x-github-request-id': 'SEARCH-REQ-1',
  };

  await expect(
    (await collector())({
      outputFile,
      token: 'github_pat_SHOULD_NOT_LEAK_12345678901234567890',
      fetchImpl: (async () =>
        new Response('{"message":"rate limited"}', { status: 403, headers })) as typeof fetch,
    }),
  ).rejects.toThrow('GitHub API 403');

  const text = readFileSync(outputFile, 'utf8');
  expect(text).not.toContain('SHOULD_NOT_LEAK');
  expect(JSON.parse(text)).toMatchObject({
    schemaVersion: 1,
    status: 'failed',
    failure: {
      kind: 'primary-rate-limit-exhausted',
      status: 403,
      rateLimit: {
        limit: '30',
        remaining: '0',
        reset: '1788224400',
        used: '30',
        resource: 'search',
      },
      retryAfter: '60',
      requestId: 'SEARCH-REQ-1',
    },
  });
});

it('distinguishes a permission denial from primary rate exhaustion', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');

  await expect(
    (await collector())({
      outputFile,
      token: 'read-only-test-token',
      fetchImpl: (async () =>
        new Response('{"message":"Resource not accessible by integration"}', {
          status: 403,
          headers: {
            'x-ratelimit-limit': '30',
            'x-ratelimit-remaining': '29',
            'x-ratelimit-reset': '1788224400',
            'x-ratelimit-used': '1',
            'x-ratelimit-resource': 'search',
            'x-github-request-id': 'SEARCH-PERMISSION-1',
          },
        })) as typeof fetch,
    }),
  ).rejects.toThrow('GitHub API 403');

  expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toMatchObject({
    status: 'failed',
    failure: {
      kind: 'permission-denied',
      status: 403,
      rateLimit: { remaining: '29', resource: 'search' },
      retryAfter: null,
      requestId: 'SEARCH-PERMISSION-1',
    },
  });
});

it('rejects Search responses without a valid total_count', async () => {
  const directory = temporaryDirectory();

  await expect(
    (await collector())({
      outputFile: join(directory, 'repository-candidates.json'),
      token: 'read-only-test-token',
      fetchImpl: invalidSearchApi({
        incomplete_results: false,
        items: [{ full_name: 'alpha/project', stargazers_count: 100 }],
      }),
    }),
  ).rejects.toThrow(/search response was incomplete or invalid/);
});

it('rejects Search responses whose item count does not match the bounded total', async () => {
  const directory = temporaryDirectory();

  await expect(
    (await collector())({
      outputFile: join(directory, 'repository-candidates.json'),
      token: 'read-only-test-token',
      fetchImpl: invalidSearchApi({
        total_count: 2,
        incomplete_results: false,
        items: [{ full_name: 'alpha/project', stargazers_count: 100 }],
      }),
    }),
  ).rejects.toThrow(/search response was incomplete or invalid/);
});

it('rejects Search candidates that are not sorted by non-increasing stars', async () => {
  const directory = temporaryDirectory();

  await expect(
    (await collector())({
      outputFile: join(directory, 'repository-candidates.json'),
      token: 'read-only-test-token',
      fetchImpl: invalidSearchApi({
        total_count: 2,
        incomplete_results: false,
        items: [
          { full_name: 'alpha/project', stargazers_count: 100 },
          { full_name: 'beta/project', stargazers_count: 101 },
        ],
      }),
    }),
  ).rejects.toThrow(/ranked by stars/);
});
