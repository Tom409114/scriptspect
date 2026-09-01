import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

type Collector = (options: {
  outputFile: string;
  token: string;
  requested?: number;
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
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('100');
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
    schemaVersion: 2,
    status: 'complete',
    method: 'popularity-strata-round-robin-v1',
    candidateTargetPerStratum: 100,
    api: {
      transport: 'github-search-rest-v1',
      perPage: 100,
      resultCeiling: 1000,
      requests: 2,
      rateLimit: {
        limit: 30,
        remaining: 28,
        reset: 1788220800,
        used: 2,
        resource: 'search',
      },
    },
    strata: [
      {
        id: 'typescript',
        query: 'is:public language:typescript stars:>2000',
        sort: 'stars',
        order: 'desc',
        perPage: 100,
        totalCount: 2,
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pages: [
          {
            page: 1,
            itemCount: 2,
            responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
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
        totalCount: 2,
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pages: [
          {
            page: 1,
            itemCount: 2,
            responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
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

it('hashes the complete Search page while retaining only the requested candidate prefix', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');
  let requestCount = 0;

  await (await collector())({
    outputFile,
    token: 'read-only-test-token',
    requested: 1,
    fetchImpl: (async (input: string | URL | Request) => {
      requestCount += 1;
      const url = new URL(String(input));
      const language = url.searchParams.get('q')?.includes('typescript')
        ? 'typescript'
        : 'javascript';
      return Response.json(
        {
          total_count: 5_000,
          incomplete_results: false,
          items: Array.from({ length: 100 }, (_, index) => ({
            full_name: `${language}/project-${String(index + 1).padStart(4, '0')}`,
            stargazers_count: 5_000 - index,
          })),
        },
        {
          headers: {
            'x-ratelimit-limit': '30',
            'x-ratelimit-remaining': String(30 - requestCount),
            'x-ratelimit-reset': '1788220800',
            'x-ratelimit-used': String(requestCount),
            'x-ratelimit-resource': 'search',
          },
        },
      );
    }) as typeof fetch,
  });

  const snapshot = JSON.parse(readFileSync(outputFile, 'utf8')) as {
    strata: Array<{
      pages: Array<{ page: number; itemCount: number; responseSha256: string }>;
      candidates: Array<{ rank: number; repository: string }>;
    }>;
    orderedCandidates: unknown[];
  };
  expect(snapshot.strata).toHaveLength(2);
  expect(snapshot.strata[0]).toMatchObject({
    pages: [{ page: 1, itemCount: 100, responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    candidates: [{ rank: 1, repository: 'typescript/project-0001' }],
  });
  expect(snapshot.strata[1]).toMatchObject({
    pages: [{ page: 1, itemCount: 100, responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    candidates: [{ rank: 1, repository: 'javascript/project-0001' }],
  });
  expect(snapshot.orderedCandidates).toHaveLength(2);
  expect(requestCount).toBe(2);
});

it('paginates both Search strata through the 1000-result ceiling deterministically', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');
  const requests: Array<{ language: string; page: number }> = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    const url = new URL(String(input));
    const query = url.searchParams.get('q') ?? '';
    const language = query.includes('language:typescript') ? 'typescript' : 'javascript';
    const page = Number(url.searchParams.get('page'));
    requests.push({ language, page });
    const offset = (page - 1) * 100;
    const items = Array.from({ length: 100 }, (_, index) => ({
      full_name: `${language}/project-${String(offset + index + 1).padStart(4, '0')}`,
      stargazers_count: 20_000 - offset - index,
    }));
    const used = requests.length;
    return Response.json(
      { total_count: 5_000, incomplete_results: false, items },
      {
        headers: {
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': String(30 - used),
          'x-ratelimit-reset': '1788220800',
          'x-ratelimit-used': String(used),
          'x-ratelimit-resource': 'search',
          'x-github-request-id': `SEARCH:${language}:${page}`,
          link: `<https://api.github.com/search/repositories?page=${page + 1}>; rel="next"`,
        },
      },
    );
  }) as typeof fetch;

  await (await collector())({
    outputFile,
    token: 'read-only-test-token',
    requested: 1000,
    fetchImpl,
  });

  const snapshot = JSON.parse(readFileSync(outputFile, 'utf8')) as {
    candidateTargetPerStratum: number;
    api: { requests: number; rateLimit: { remaining: number; used: number } };
    strata: Array<{
      totalCount: number;
      pages: Array<{ page: number; itemCount: number; responseSha256: string }>;
      candidates: Array<{ rank: number; repository: string; stars: number }>;
    }>;
    orderedCandidates: Array<{ position: number; repository: string }>;
  };
  expect(requests).toEqual([
    ...Array.from({ length: 10 }, (_, index) => ({ language: 'typescript', page: index + 1 })),
    ...Array.from({ length: 10 }, (_, index) => ({ language: 'javascript', page: index + 1 })),
  ]);
  expect(snapshot.candidateTargetPerStratum).toBe(1000);
  expect(snapshot.api).toMatchObject({ requests: 20, rateLimit: { remaining: 10, used: 20 } });
  expect(snapshot.strata).toHaveLength(2);
  for (const stratum of snapshot.strata) {
    expect(stratum.totalCount).toBe(5_000);
    expect(stratum.pages).toHaveLength(10);
    expect(stratum.pages.map((page) => page.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stratum.pages.every((page) => page.itemCount === 100)).toBe(true);
    expect(stratum.pages.every((page) => /^[a-f0-9]{64}$/.test(page.responseSha256))).toBe(true);
    expect(stratum.candidates).toHaveLength(1000);
    expect(stratum.candidates.at(-1)?.rank).toBe(1000);
  }
  expect(snapshot.orderedCandidates).toHaveLength(2000);
  expect(snapshot.orderedCandidates.slice(0, 4)).toEqual([
    { position: 1, repository: 'typescript/project-0001', rank: 1, stratum: 'typescript' },
    { position: 2, repository: 'javascript/project-0001', rank: 1, stratum: 'javascript' },
    { position: 3, repository: 'typescript/project-0002', rank: 2, stratum: 'typescript' },
    { position: 4, repository: 'javascript/project-0002', rank: 2, stratum: 'javascript' },
  ]);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'corpus-candidates.ts')).href;
  const module = (await import(moduleUrl)) as {
    parseCorpusCandidateSnapshot: (bytes: Buffer) => {
      snapshot: { schemaVersion: number; orderedCandidates: unknown[] };
    };
  };
  const parsed = module.parseCorpusCandidateSnapshot(readFileSync(outputFile));
  expect(parsed.snapshot.schemaVersion).toBe(2);
  expect(parsed.snapshot.orderedCandidates).toHaveLength(2000);
});

it('fails closed when GitHub marks a paginated Search response incomplete', async () => {
  const directory = temporaryDirectory();

  await expect(
    (await collector())({
      outputFile: join(directory, 'repository-candidates.json'),
      token: 'read-only-test-token',
      requested: 500,
      fetchImpl: (async () =>
        Response.json({
          total_count: 5_000,
          incomplete_results: true,
          items: Array.from({ length: 100 }, (_, index) => ({
            full_name: `typescript/incomplete-${index}`,
            stargazers_count: 1_000 - index,
          })),
        })) as typeof fetch,
    }),
  ).rejects.toThrow(/search response was incomplete or invalid/);
});

it.each([0, 1001, 1.5])(
  'rejects requested candidate target %s before Search access',
  async (requested) => {
    const directory = temporaryDirectory();
    let called = false;

    await expect(
      (await collector())({
        outputFile: join(directory, 'repository-candidates.json'),
        token: 'read-only-test-token',
        requested,
        fetchImpl: (async () => {
          called = true;
          return new Response('unexpected');
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/integer from 1 through 1000/);
    expect(called).toBe(false);
  },
);

it.each([
  ['missing', undefined],
  ['empty', ''],
  ['whitespace-only', '   '],
  ['non-decimal', '1e1'],
] as const)('rejects a %s Search rate-limit integer header', async (_label, remaining) => {
  const directory = temporaryDirectory();
  const headers = new Headers({
    'x-ratelimit-limit': '30',
    'x-ratelimit-reset': '1788220800',
    'x-ratelimit-used': '2',
    'x-ratelimit-resource': 'search',
  });
  if (remaining !== undefined) headers.set('x-ratelimit-remaining', remaining);

  await expect(
    (await collector())({
      outputFile: join(directory, 'repository-candidates.json'),
      token: 'read-only-test-token',
      fetchImpl: (async (input: string | URL | Request) => {
        const language = new URL(String(input)).searchParams
          .get('q')
          ?.includes('language:typescript')
          ? 'typescript'
          : 'javascript';
        return Response.json(
          {
            total_count: 1,
            incomplete_results: false,
            items: [{ full_name: `${language}/project`, stargazers_count: 100 }],
          },
          { headers },
        );
      }) as typeof fetch,
    }),
  ).rejects.toThrow(/x-ratelimit-remaining header was invalid/);
});

it('accepts canonical zero and positive Search rate-limit integer headers', async () => {
  const directory = temporaryDirectory();
  const outputFile = join(directory, 'repository-candidates.json');
  let requests = 0;

  await (await collector())({
    outputFile,
    token: 'read-only-test-token',
    requested: 1,
    fetchImpl: (async (input: string | URL | Request) => {
      requests += 1;
      const language = new URL(String(input)).searchParams.get('q')?.includes('language:typescript')
        ? 'typescript'
        : 'javascript';
      return Response.json(
        {
          total_count: 1,
          incomplete_results: false,
          items: [{ full_name: `${language}/project`, stargazers_count: 100 }],
        },
        {
          headers: {
            'x-ratelimit-limit': '30',
            'x-ratelimit-remaining': requests === 1 ? '1' : '0',
            'x-ratelimit-reset': '1788220800',
            'x-ratelimit-used': requests === 1 ? '29' : '30',
            'x-ratelimit-resource': 'search',
          },
        },
      );
    }) as typeof fetch,
  });

  expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toMatchObject({
    status: 'complete',
    api: { rateLimit: { remaining: 0, used: 30 } },
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
    schemaVersion: 2,
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
