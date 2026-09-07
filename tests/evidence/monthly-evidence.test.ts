import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, it } from 'vitest';

type EvidenceMetric = {
  value: number | string | null;
  status: 'observed' | 'missing' | 'partial' | 'not-collected';
  sources: string[];
  note: string;
};

type EvidenceDraft = {
  schemaVersion: string;
  repository: string;
  package: string;
  period: string;
  collectedAt: string;
  generation: { status: 'complete' | 'partial' };
  sources: Array<{
    id: string;
    startedAt: string;
    completedAt: string;
    completeness: 'complete' | 'partial' | 'missing';
    httpStatus: number | null;
    note: string;
    response: {
      sha256: string | null;
      pageSha256: Array<string | null>;
      recordCount: number | null;
    };
  }>;
  ledger: {
    adoption: { reviewState: string; metrics: Record<string, EvidenceMetric> };
    community: { reviewState: string; metrics: Record<string, EvidenceMetric> };
    maintenance: { reviewState: string; metrics: Record<string, EvidenceMetric> };
    quality: { reviewState: string; metrics: Record<string, EvidenceMetric> };
    impact: { reviewState: string; metrics: Record<string, EvidenceMetric> };
    aiLeverage: { reviewState: string; metrics: Record<string, EvidenceMetric> };
  };
  review: {
    state: string;
    reviewer: string | null;
    reviewedAt: string | null;
    approvedForPublication: boolean;
  };
};

type CollectMonthlyEvidence = (options: {
  repository: string;
  packageName: string;
  githubToken: string;
  now: Date;
  commitSha: string;
  workflowRunUrl: string;
  fetchImpl: typeof fetch;
}) => Promise<EvidenceDraft>;

async function collector(): Promise<CollectMonthlyEvidence> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    collectMonthlyEvidence?: CollectMonthlyEvidence;
  };
  expect(typeof module.collectMonthlyEvidence).toBe('function');
  if (module.collectMonthlyEvidence === undefined) {
    throw new Error('monthly evidence collector was unavailable');
  }
  return module.collectMonthlyEvidence;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function completeResponse(url: string): Response {
  if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
    return Response.json({
      id: 1,
      full_name: 'Tom409114/scriptspect',
      owner: { login: 'Tom409114', type: 'User' },
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
    });
  }
  if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
  if (url.includes('/actions/workflows/ci.yml/runs?')) {
    return Response.json({ total_count: 0, workflow_runs: [] });
  }
  if (url === 'https://registry.npmjs.org/scriptspect') {
    return Response.json({ name: 'scriptspect', 'dist-tags': { latest: '0.1.0' } });
  }
  if (url.endsWith('/downloads/point/last-month/scriptspect')) {
    return Response.json({ downloads: 0, package: 'scriptspect' });
  }
  return new Response('{"message":"unexpected URL"}', { status: 500 });
}

it('builds a schema-valid unreviewed six-category draft from complete public responses', async () => {
  const responseBodies = new Map<string, string>([
    [
      'https://api.github.com/repos/Tom409114/scriptspect',
      JSON.stringify({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 7,
        forks_count: 2,
        open_issues_count: 3,
      }),
    ],
    [
      'https://api.github.com/repos/Tom409114/scriptspect/issues?state=all&per_page=100',
      JSON.stringify([
        {
          id: 101,
          number: 1,
          user: { login: 'outside-contributor', type: 'User' },
          created_at: '2026-08-20T00:00:00Z',
        },
        {
          id: 102,
          number: 2,
          user: { login: 'Tom409114', type: 'User' },
          created_at: '2026-08-21T00:00:00Z',
        },
        {
          id: 103,
          number: 3,
          user: { login: 'dependabot[bot]', type: 'Bot' },
          created_at: '2026-08-22T00:00:00Z',
          pull_request: { url: 'https://api.github.com/repos/Tom409114/scriptspect/pulls/3' },
        },
      ]),
    ],
    [
      'https://api.github.com/repos/Tom409114/scriptspect/releases?per_page=100',
      JSON.stringify([
        {
          id: 201,
          tag_name: 'v0.1.0',
          published_at: '2026-08-25T00:00:00Z',
          draft: false,
        },
      ]),
    ],
    [
      'https://api.github.com/repos/Tom409114/scriptspect/actions/workflows/ci.yml/runs?per_page=100',
      JSON.stringify({
        total_count: 2,
        workflow_runs: [
          { id: 11, event: 'push', status: 'completed', conclusion: 'success' },
          { id: 12, event: 'pull_request', status: 'completed', conclusion: 'failure' },
        ],
      }),
    ],
    [
      'https://registry.npmjs.org/scriptspect',
      JSON.stringify({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      }),
    ],
    [
      'https://api.npmjs.org/downloads/point/last-month/scriptspect',
      JSON.stringify({
        downloads: 123,
        start: '2026-08-01',
        end: '2026-08-31',
        package: 'scriptspect',
      }),
    ],
  ]);
  const githubToken = 'github_pat_SHOULD_NOT_LEAK_12345678901234567890';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.startsWith('https://api.github.com/')) {
      expect(authorization).toBe(`Bearer ${githubToken}`);
    } else {
      expect(authorization).toBeNull();
    }
    const body = responseBodies.get(url);
    if (body === undefined) return new Response('{"message":"not found"}', { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken,
    now: new Date('2026-09-01T08:30:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1234',
    fetchImpl,
  });

  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'docs', 'evidence', 'monthly-draft.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  expect(validate(draft), JSON.stringify(validate.errors)).toBe(true);
  expect(draft).toMatchObject({
    schemaVersion: 'scriptspect-monthly-evidence-draft/v1',
    repository: 'Tom409114/scriptspect',
    package: 'scriptspect',
    period: '2026-09',
    collectedAt: '2026-09-01T08:30:00.000Z',
    generation: { status: 'complete' },
    review: {
      state: 'unreviewed',
      reviewer: null,
      reviewedAt: null,
      approvedForPublication: false,
    },
    ledger: {
      adoption: {
        reviewState: 'unreviewed',
        metrics: {
          stars: { value: 7, status: 'observed', sources: ['github-repository'] },
          forks: { value: 2, status: 'observed', sources: ['github-repository'] },
          npmDownloadsLastMonth: {
            value: 123,
            status: 'observed',
            sources: ['npm-downloads'],
          },
          latestNpmVersion: {
            value: '0.1.0',
            status: 'observed',
            sources: ['npm-package'],
          },
        },
      },
      community: {
        reviewState: 'unreviewed',
        metrics: {
          externalIssues: { value: 1, status: 'observed', sources: ['github-issues'] },
          externalPullRequests: {
            value: 0,
            status: 'observed',
            sources: ['github-issues'],
          },
        },
      },
      maintenance: {
        reviewState: 'unreviewed',
        metrics: {
          publicReleases: { value: 1, status: 'observed', sources: ['github-releases'] },
          latestReleaseAt: {
            value: '2026-08-25T00:00:00Z',
            status: 'observed',
            sources: ['github-releases'],
          },
        },
      },
      quality: {
        reviewState: 'unreviewed',
        metrics: {
          hostedCiRuns: { value: 2, status: 'observed', sources: ['github-actions-ci'] },
          hostedCiSuccessfulRuns: {
            value: 1,
            status: 'observed',
            sources: ['github-actions-ci'],
          },
          hostedCiPassRate: {
            value: 0.5,
            status: 'observed',
            sources: ['github-actions-ci'],
          },
        },
      },
      impact: { reviewState: 'unreviewed' },
      aiLeverage: { reviewState: 'unreviewed' },
    },
  });
  expect(Object.keys(draft.ledger)).toEqual([
    'adoption',
    'community',
    'maintenance',
    'quality',
    'impact',
    'aiLeverage',
  ]);
  expect(draft.sources).toHaveLength(6);
  for (const source of draft.sources) {
    expect(source).toMatchObject({
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(Date.parse(source.completedAt)).toBeGreaterThanOrEqual(Date.parse(source.startedAt));
  }
  expect(draft.sources.find(({ id }) => id === 'github-repository')?.response.sha256).toBe(
    sha256(responseBodies.get('https://api.github.com/repos/Tom409114/scriptspect') ?? ''),
  );
  expect(JSON.stringify(draft)).not.toContain('SHOULD_NOT_LEAK');
});

it('fails closed instead of promoting a partial-content 2xx response', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/issues?')) {
      return new Response('[]', {
        status: 206,
        headers: { 'content-type': 'application/json' },
      });
    }
    return completeResponse(url);
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:45:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12345',
    fetchImpl,
  });

  expect(draft.generation.status).toBe('partial');
  expect(draft.sources.find(({ id }) => id === 'github-issues')).toMatchObject({
    completeness: 'partial',
    httpStatus: 206,
  });
  expect(draft.ledger.community.metrics.externalIssues).toMatchObject({
    value: null,
    status: 'partial',
  });
});

it('hashes and measures exact response bytes before UTF-8 BOM decoding', async () => {
  const repositoryJson = JSON.stringify({
    id: 1,
    full_name: 'Tom409114/scriptspect',
    owner: { login: 'Tom409114', type: 'User' },
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
  });
  const rawBody = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(repositoryJson)]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return new Response(rawBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return completeResponse(url);
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:46:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12346',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-repository')).toMatchObject({
    completeness: 'complete',
    response: {
      sha256: sha256(rawBody),
      byteLength: rawBody.byteLength,
    },
  });
});

it('marks invalid UTF-8 response bytes partial while retaining their exact receipt', async () => {
  const rawBody = Buffer.from([0xff, 0x7b, 0x7d]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/releases?')) {
      return new Response(rawBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return completeResponse(url);
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:47:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12347',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-releases')).toMatchObject({
    completeness: 'partial',
    note: expect.stringMatching(/UTF-8/u),
    response: {
      sha256: sha256(rawBody),
      byteLength: rawBody.byteLength,
    },
  });
  expect(draft.ledger.maintenance.metrics.publicReleases).toMatchObject({
    value: null,
    status: 'partial',
  });
});

it('collects every GitHub Actions page before promoting exact hosted-run totals', async () => {
  const requestedUrls: string[] = [];
  const firstPageRuns = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }));
  const firstPageBody = JSON.stringify({ total_count: 101, workflow_runs: firstPageRuns });
  const secondPageBody = JSON.stringify({
    total_count: 101,
    workflow_runs: [{ id: 101, event: 'push', status: 'completed', conclusion: 'failure' }],
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100&page=2')) {
      return new Response(secondPageBody, { headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100')) {
      return new Response(firstPageBody, {
        headers: {
          'content-type': 'application/json',
          link: '<https://api.github.com/repositories/1/actions/workflows/ci.yml/runs?per_page=100&page=2>; rel="next"',
        },
      });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({
        downloads: 0,
        start: '2026-08-01',
        end: '2026-08-31',
        package: 'scriptspect',
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:45:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12345',
    fetchImpl,
  });

  expect(requestedUrls).toContain(
    'https://api.github.com/repos/Tom409114/scriptspect/actions/workflows/ci.yml/runs?per_page=100&page=2',
  );
  expect(draft.generation.status).toBe('complete');
  expect(draft.sources.find(({ id }) => id === 'github-actions-ci')).toMatchObject({
    completeness: 'complete',
    httpStatus: 200,
    response: {
      sha256: sha256(`1:${sha256(firstPageBody)}\n2:${sha256(secondPageBody)}`),
      pageSha256: [sha256(firstPageBody), sha256(secondPageBody)],
      recordCount: 101,
    },
    note: expect.stringMatching(/2 GitHub API pages/u),
  });
  expect(draft.ledger.quality.metrics.hostedCiRuns).toMatchObject({
    value: 101,
    status: 'observed',
  });
  expect(draft.ledger.quality.metrics.hostedCiSuccessfulRuns).toMatchObject({
    value: 100,
    status: 'observed',
  });
  expect(draft.ledger.quality.metrics.hostedCiPassRate).toMatchObject({
    value: 100 / 101,
    status: 'observed',
  });
});

it.each([
  {
    name: 'rel=next remains after total_count rows are already present',
    first: Response.json(
      {
        total_count: 1,
        workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }],
      },
      {
        headers: {
          link: '<https://api.github.com/repositories/1/actions/workflows/ci.yml/runs?per_page=100&page=2>; rel="next"',
        },
      },
    ),
    second: Response.json({ total_count: 1, workflow_runs: [] }),
  },
  {
    name: 'total_count advertises another row without rel=next',
    first: Response.json({
      total_count: 2,
      workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }],
    }),
    second: Response.json({
      total_count: 2,
      workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success' }],
    }),
  },
  {
    name: 'rel=next points away from the fixed GitHub API origin',
    first: Response.json(
      {
        total_count: 2,
        workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }],
      },
      {
        headers: {
          link: '<https://attacker.invalid/token-capture?page=2>; rel="next"',
        },
      },
    ),
    second: Response.json({
      total_count: 2,
      workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success' }],
    }),
  },
])('fails closed when Actions pagination metadata conflict: $name', async ({ first, second }) => {
  const requestedUrls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        full_name: 'Tom409114/scriptspect',
        stargazers_count: 0,
        forks_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100&page=2')) {
      return second.clone();
    }
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100')) return first.clone();
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({ name: 'scriptspect', 'dist-tags': { latest: '0.1.0' } });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({ downloads: 0 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:50:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12346',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-actions-ci')).toMatchObject({
    completeness: 'partial',
  });
  expect(draft.ledger.quality.metrics.hostedCiRuns).toMatchObject({
    value: null,
    status: 'partial',
  });
  expect(requestedUrls.some((url) => url.startsWith('https://attacker.invalid/'))).toBe(false);
});

it('fails closed when the same immutable workflow-run id appears on two pages', async () => {
  const repeatedRun = { id: 41, status: 'completed', conclusion: 'success' };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        full_name: 'Tom409114/scriptspect',
        stargazers_count: 0,
        forks_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100&page=2')) {
      return Response.json({ total_count: 2, workflow_runs: [repeatedRun] });
    }
    if (url.endsWith('/actions/workflows/ci.yml/runs?per_page=100')) {
      return Response.json(
        { total_count: 2, workflow_runs: [repeatedRun] },
        {
          headers: {
            link: '<https://api.github.com/repositories/1/actions/workflows/ci.yml/runs?per_page=100&page=2>; rel="next"',
          },
        },
      );
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({ name: 'scriptspect', 'dist-tags': { latest: '0.1.0' } });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({ downloads: 0 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:55:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12347',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-actions-ci')).toMatchObject({
    completeness: 'partial',
    response: { recordCount: 1 },
  });
  for (const metric of [
    draft.ledger.quality.metrics.hostedCiRuns,
    draft.ledger.quality.metrics.hostedCiSuccessfulRuns,
    draft.ledger.quality.metrics.hostedCiPassRate,
  ]) {
    expect(metric).toMatchObject({ value: null, status: 'partial' });
  }
});

it.each([
  {
    endpoint: 'issues',
    sourceId: 'github-issues',
    firstRow: {
      id: 301,
      number: 1,
      user: { login: 'outside-contributor', type: 'User' },
    },
    metricNames: ['externalIssues', 'externalPullRequests'],
  },
  {
    endpoint: 'releases',
    sourceId: 'github-releases',
    firstRow: {
      id: 401,
      tag_name: 'v0.1.0',
      published_at: '2026-08-25T00:00:00Z',
      draft: false,
    },
    metricNames: ['publicReleases', 'latestReleaseAt'],
  },
])(
  'fails closed when a duplicate immutable id appears across $endpoint pages',
  async ({ endpoint, sourceId, firstRow, metricNames }) => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
        return Response.json({
          full_name: 'Tom409114/scriptspect',
          stargazers_count: 0,
          forks_count: 0,
        });
      }
      if (url.includes(`/${endpoint}?`)) {
        if (url.includes('page=2')) return Response.json([firstRow]);
        const linkQuery = endpoint === 'issues' ? 'state=all&per_page=100&' : 'per_page=100&';
        return Response.json([firstRow], {
          headers: {
            link: `<https://api.github.com/repositories/1/${endpoint}?${linkQuery}page=2>; rel="next"`,
          },
        });
      }
      if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
      if (url.includes('/actions/workflows/ci.yml/runs?')) {
        return Response.json({ total_count: 0, workflow_runs: [] });
      }
      if (url === 'https://registry.npmjs.org/scriptspect') {
        return Response.json({ name: 'scriptspect', 'dist-tags': { latest: '0.1.0' } });
      }
      if (url.endsWith('/downloads/point/last-month/scriptspect')) {
        return Response.json({ downloads: 0 });
      }
      return new Response('{"message":"unexpected URL"}', { status: 500 });
    }) as typeof fetch;

    const draft = await (await collector())({
      repository: 'Tom409114/scriptspect',
      packageName: 'scriptspect',
      githubToken: 'read-only-test-token',
      now: new Date('2026-09-01T08:57:00.000Z'),
      commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
      workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12348',
      fetchImpl,
    });

    expect(draft.sources.find(({ id }) => id === sourceId)).toMatchObject({
      completeness: 'partial',
      response: { recordCount: 1 },
      note: expect.stringMatching(/duplicate/iu),
    });
    const category = endpoint === 'issues' ? draft.ledger.community : draft.ledger.maintenance;
    for (const metricName of metricNames) {
      expect(category.metrics[metricName]).toMatchObject({ value: null, status: 'partial' });
    }
  },
);

it.each([
  {
    endpoint: 'issues',
    link: '<https://attacker.invalid/issues?page=2>; rel="next"',
  },
  {
    endpoint: 'releases',
    link: '<https://api.github.com/repositories/1/releases?per_page=100&page=3>; rel="next"',
  },
])('rejects unsafe or non-sequential $endpoint pagination Links', async ({ endpoint, link }) => {
  const requestedUrls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        full_name: 'Tom409114/scriptspect',
        stargazers_count: 0,
        forks_count: 0,
      });
    }
    if (url.includes(`/${endpoint}?`)) return Response.json([], { headers: { link } });
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({ name: 'scriptspect', 'dist-tags': { latest: '0.1.0' } });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({ downloads: 0 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T08:58:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/12349',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === `github-${endpoint}`)).toMatchObject({
    completeness: 'partial',
    note: expect.stringMatching(/next-page Link/u),
  });
  expect(requestedUrls.some((url) => url.startsWith('https://attacker.invalid/'))).toBe(false);
});

it('keeps paginated and missing-source metrics null instead of manufacturing zeroes', async () => {
  const token = 'github_pat_ECHOED_SECRET_12345678901234567890';
  const responses = new Map<string, Response>([
    [
      'https://api.github.com/repos/Tom409114/scriptspect',
      Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      }),
    ],
    [
      'https://api.github.com/repos/Tom409114/scriptspect/issues?state=all&per_page=100',
      Response.json([], {
        headers: {
          link: '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=2>; rel="next"',
        },
      }),
    ],
    ['https://api.github.com/repos/Tom409114/scriptspect/releases?per_page=100', Response.json([])],
    [
      'https://api.github.com/repos/Tom409114/scriptspect/actions/workflows/ci.yml/runs?per_page=100',
      Response.json({ total_count: 0, workflow_runs: [] }),
    ],
    [
      'https://registry.npmjs.org/scriptspect',
      Response.json({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      }),
    ],
    [
      'https://api.npmjs.org/downloads/point/last-month/scriptspect',
      new Response(JSON.stringify({ error: `package not found; authorization=${token}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ],
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const response = responses.get(String(input));
    return response?.clone() ?? new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: token,
    now: new Date('2026-09-01T09:00:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1235',
    fetchImpl,
  });

  expect(draft.generation.status).toBe('partial');
  expect(draft.sources.find(({ id }) => id === 'github-issues')).toMatchObject({
    completeness: 'partial',
    httpStatus: 500,
    response: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(draft.ledger.community.metrics.externalIssues).toMatchObject({
    value: null,
    status: 'partial',
    sources: ['github-issues'],
  });
  expect(draft.ledger.community.metrics.externalPullRequests).toMatchObject({
    value: null,
    status: 'partial',
    sources: ['github-issues'],
  });
  expect(draft.sources.find(({ id }) => id === 'npm-downloads')).toMatchObject({
    completeness: 'missing',
    httpStatus: 404,
    response: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(draft.ledger.adoption.metrics.npmDownloadsLastMonth).toMatchObject({
    value: null,
    status: 'missing',
    sources: ['npm-downloads'],
  });
  expect(JSON.stringify(draft)).not.toContain('ECHOED_SECRET');
});

it('records a transport failure without persisting the thrown credential text', async () => {
  const token = 'github_pat_TRANSPORT_SECRET_12345678901234567890';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      throw new Error(`socket failure with authorization=${token}`);
    }
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: token,
    now: new Date('2026-09-01T09:30:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1236',
    fetchImpl,
  });

  expect(draft.generation.status).toBe('partial');
  expect(draft.sources.find(({ id }) => id === 'npm-downloads')).toMatchObject({
    completeness: 'partial',
    httpStatus: null,
    response: {
      sha256: null,
      byteLength: null,
      jsonType: null,
      topLevelKeys: [],
      recordCount: null,
    },
  });
  expect(draft.ledger.adoption.metrics.npmDownloadsLastMonth).toMatchObject({
    value: null,
    status: 'partial',
    sources: ['npm-downloads'],
  });
  expect(JSON.stringify(draft)).not.toContain('TRANSPORT_SECRET');
});

it('hashes malformed response bytes but keeps the affected metric partial and null', async () => {
  const malformedBody = '<html>temporary upstream error</html>';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?')) return Response.json([]);
    if (url.includes('/releases?')) {
      return new Response(malformedBody, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({
        downloads: 0,
        start: '2026-08-01',
        end: '2026-08-31',
        package: 'scriptspect',
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T10:00:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1237',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-releases')).toMatchObject({
    completeness: 'partial',
    httpStatus: 200,
    response: {
      sha256: sha256(malformedBody),
      byteLength: Buffer.byteLength(malformedBody),
      jsonType: null,
    },
  });
  expect(draft.ledger.maintenance.metrics.publicReleases).toMatchObject({
    value: null,
    status: 'partial',
    sources: ['github-releases'],
  });
  expect(JSON.stringify(draft)).not.toContain(malformedBody);
});

it('represents the current pre-publish npm 404 state as missing rather than zero', async () => {
  const token = 'github_pat_PREPUBLISH_SECRET_12345678901234567890';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (
      url === 'https://registry.npmjs.org/scriptspect' ||
      url.endsWith('/downloads/point/last-month/scriptspect')
    ) {
      return new Response(JSON.stringify({ error: `not found; authorization=${token}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: token,
    now: new Date('2026-09-01T10:30:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1238',
    fetchImpl,
  });

  expect(draft.generation.status).toBe('partial');
  expect(draft.sources.find(({ id }) => id === 'npm-package')).toMatchObject({
    completeness: 'missing',
    httpStatus: 404,
  });
  expect(draft.ledger.adoption.metrics.latestNpmVersion).toMatchObject({
    value: null,
    status: 'missing',
    sources: ['npm-package'],
  });
  expect(draft.ledger.adoption.metrics.npmDownloadsLastMonth).toMatchObject({
    value: null,
    status: 'missing',
    sources: ['npm-downloads'],
  });
  expect(JSON.stringify(draft)).not.toContain('PREPUBLISH_SECRET');
});

it('does not promote paginated release or CI first-page counts to totals', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?')) return Response.json([]);
    if (url.includes('/releases?')) {
      if (url.includes('page=2')) {
        return new Response('{"message":"simulated pagination failure"}', { status: 503 });
      }
      return Response.json(
        [
          {
            id: 501,
            tag_name: 'v0.1.0',
            published_at: '2026-08-25T00:00:00Z',
            draft: false,
          },
        ],
        {
          headers: {
            link: '<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next"',
          },
        },
      );
    }
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      if (url.includes('page=2')) {
        return new Response('{"message":"simulated pagination failure"}', { status: 503 });
      }
      return Response.json({
        total_count: 2,
        workflow_runs: [{ id: 11, event: 'push', status: 'completed', conclusion: 'success' }],
      });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({
        name: 'scriptspect',
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { name: 'scriptspect', version: '0.1.0' } },
      });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({
        downloads: 0,
        start: '2026-08-01',
        end: '2026-08-31',
        package: 'scriptspect',
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: 'read-only-test-token',
    now: new Date('2026-09-01T11:30:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1240',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'github-releases')).toMatchObject({
    completeness: 'partial',
  });
  expect(draft.ledger.maintenance.metrics.publicReleases).toMatchObject({
    value: null,
    status: 'partial',
  });
  expect(draft.ledger.maintenance.metrics.latestReleaseAt).toMatchObject({
    value: null,
    status: 'partial',
  });
  expect(draft.sources.find(({ id }) => id === 'github-actions-ci')).toMatchObject({
    completeness: 'partial',
  });
  for (const metric of [
    draft.ledger.quality.metrics.hostedCiRuns,
    draft.ledger.quality.metrics.hostedCiSuccessfulRuns,
    draft.ledger.quality.metrics.hostedCiPassRate,
  ]) {
    expect(metric).toMatchObject({ value: null, status: 'partial' });
  }
});

it('records a response-body transport failure without exposing exception text', async () => {
  const token = 'github_pat_BODY_STREAM_SECRET_12345678901234567890';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        id: 1,
        full_name: 'Tom409114/scriptspect',
        owner: { login: 'Tom409114', type: 'User' },
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      const response = Response.json({ name: 'scriptspect' });
      Object.defineProperty(response, 'arrayBuffer', {
        value: async () => {
          throw new Error(`stream failed with authorization=${token}`);
        },
      });
      return response;
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({
        downloads: 0,
        start: '2026-08-01',
        end: '2026-08-31',
        package: 'scriptspect',
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  const draft = await (await collector())({
    repository: 'Tom409114/scriptspect',
    packageName: 'scriptspect',
    githubToken: token,
    now: new Date('2026-09-01T12:00:00.000Z'),
    commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1241',
    fetchImpl,
  });

  expect(draft.sources.find(({ id }) => id === 'npm-package')).toMatchObject({
    completeness: 'partial',
    httpStatus: 200,
    response: {
      sha256: null,
      byteLength: null,
      jsonType: null,
      topLevelKeys: [],
      recordCount: null,
    },
  });
  expect(draft.ledger.adoption.metrics.latestNpmVersion).toMatchObject({
    value: null,
    status: 'partial',
  });
  expect(JSON.stringify(draft)).not.toContain('BODY_STREAM_SECRET');
});
