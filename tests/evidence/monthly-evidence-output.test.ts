import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const itWithFileSymlinks = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function draftFixture() {
  const emptyCategory = {
    reviewState: 'unreviewed',
    reviewer: null,
    reviewedAt: null,
    metrics: {
      pending: {
        value: null,
        status: 'not-collected',
        sources: [],
        note: 'Requires maintainer review.',
      },
    },
  } as const;
  return {
    schemaVersion: 'scriptspect-monthly-evidence-draft/v1',
    repository: 'Tom409114/scriptspect',
    package: 'scriptspect',
    period: '2026-09',
    collectedAt: '2026-09-01T08:30:00.000Z',
    generation: {
      status: 'partial',
      automated: true,
      commitSha: '50d02d44abdbfb3489516f39f4251481dfec1548',
      workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1234',
    },
    sources: [
      {
        id: 'github-issues',
        provider: 'github',
        method: 'GET',
        url: 'https://api.github.com/repos/Tom409114/scriptspect/issues',
        query: { state: 'all', per_page: '100' },
        startedAt: '2026-09-01T08:30:00.000Z',
        completedAt: '2026-09-01T08:30:01.000Z',
        completeness: 'partial',
        httpStatus: 200,
        response: {
          sha256: 'a'.repeat(64),
          pageSha256: ['a'.repeat(64)],
          byteLength: 2,
          jsonType: 'array',
          topLevelKeys: [],
          recordCount: 0,
        },
        note: 'Additional pages exist.',
      },
    ],
    ledger: {
      adoption: emptyCategory,
      community: emptyCategory,
      maintenance: emptyCategory,
      quality: emptyCategory,
      impact: emptyCategory,
      aiLeverage: emptyCategory,
    },
    review: {
      state: 'unreviewed',
      reviewer: null,
      reviewedAt: null,
      approvedForPublication: false,
    },
    warnings: ['github-issues: partial; affected metrics remain null pending review'],
  } as const;
}

type RunMonthlyEvidenceCli = (options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  now: Date;
  requestTimeoutMs?: number;
  collectionTimeoutMs?: number;
  workingDirectory: string;
}) => Promise<void>;

async function cliRunner(): Promise<RunMonthlyEvidenceCli> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: RunMonthlyEvidenceCli;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');
  return module.runMonthlyEvidenceCli;
}

function completeMonthlyResponse(url: string): Response {
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

function cliArguments(): string[] {
  return [
    '--repository',
    'Tom409114/scriptspect',
    '--package',
    'scriptspect',
    '--json',
    'draft.json',
    '--markdown',
    'draft.md',
  ];
}

it('writes auditable JSON and reviewer-facing Markdown without turning a draft into a claim', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    renderMonthlyEvidenceMarkdown?: (draft: ReturnType<typeof draftFixture>) => string;
    writeMonthlyEvidenceDraft?: (
      draft: ReturnType<typeof draftFixture>,
      paths: { jsonPath: string; markdownPath: string; workingDirectory?: string },
    ) => void;
  };
  expect(typeof module.renderMonthlyEvidenceMarkdown).toBe('function');
  expect(typeof module.writeMonthlyEvidenceDraft).toBe('function');
  if (!module.renderMonthlyEvidenceMarkdown || !module.writeMonthlyEvidenceDraft) {
    throw new Error('monthly evidence output functions were unavailable');
  }

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-evidence-'));
  temporaryDirectories.push(outputDirectory);
  const jsonPath = join(outputDirectory, 'nested', 'monthly-evidence-draft.json');
  const markdownPath = join(outputDirectory, 'nested', 'monthly-evidence-draft.md');
  const draft = draftFixture();

  module.writeMonthlyEvidenceDraft(draft, {
    jsonPath,
    markdownPath,
    workingDirectory: outputDirectory,
  });

  expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual(draft);
  const markdown = readFileSync(markdownPath, 'utf8');
  expect(markdown).toBe(module.renderMonthlyEvidenceMarkdown(draft));
  expect(markdown).toContain('# Monthly evidence draft — 2026-09');
  expect(markdown).toContain('UNREVIEWED — not approved for publication');
  expect(markdown).toContain('2026-09-01T08:30:00.000Z');
  expect(markdown).toContain('https://api.github.com/repos/Tom409114/scriptspect/issues');
  expect(markdown).toContain('`per_page=100&state=all`');
  expect(markdown).toContain('`partial`');
  expect(markdown).toContain('`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`');
  for (const heading of [
    'Adoption',
    'Community',
    'Maintenance',
    'Quality',
    'Impact',
    'AI leverage',
  ]) {
    expect(markdown).toContain(`## ${heading}`);
  }
  expect(markdown).toContain('Reviewer: _unassigned_');
  expect(markdown).toContain('Review state: `unreviewed`');
  expect(markdown).not.toContain('github_pat_');
});

it('runs the CLI with credentials only from the environment and rejects token arguments', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-evidence-cli-'));
  temporaryDirectories.push(outputDirectory);
  const workingDirectory = join(outputDirectory, 'workspace');
  mkdirSync(workingDirectory);
  const jsonPath = join(workingDirectory, 'draft.json');
  const markdownPath = join(workingDirectory, 'draft.md');
  const token = 'github_pat_CLI_SECRET_12345678901234567890';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization');
    if (String(input).startsWith('https://api.github.com/')) {
      expect(authorization).toBe(`Bearer ${token}`);
    } else {
      expect(authorization).toBeNull();
    }
    return new Response('{"message":"not found"}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const env = {
    GITHUB_TOKEN: token,
    GITHUB_SHA: '50d02d44abdbfb3489516f39f4251481dfec1548',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'Tom409114/scriptspect',
    GITHUB_RUN_ID: '1239',
  };

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        jsonPath,
        '--markdown',
        markdownPath,
      ],
      env,
      fetchImpl,
      now: new Date('2026-09-01T11:00:00.000Z'),
      workingDirectory,
    }),
  ).rejects.toThrow(
    'Monthly evidence collection was partial; review the generated draft artifact.',
  );

  const combinedOutput = `${readFileSync(jsonPath, 'utf8')}\n${readFileSync(markdownPath, 'utf8')}`;
  expect(combinedOutput).toContain('"status": "partial"');
  expect(combinedOutput).not.toContain('CLI_SECRET');
  await expect(
    module.runMonthlyEvidenceCli({
      argv: ['--token', token],
      env,
      fetchImpl,
      now: new Date('2026-09-01T11:00:00.000Z'),
      workingDirectory,
    }),
  ).rejects.toThrow(/token|unknown option/iu);
  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        join(outputDirectory, 'escaped.json'),
        '--markdown',
        join(outputDirectory, 'escaped.md'),
      ],
      env,
      fetchImpl,
      now: new Date('2026-09-01T11:00:00.000Z'),
      workingDirectory,
    }),
  ).rejects.toThrow(/output path|working directory/iu);
});

it('writes a successful pre-publish draft when only the two npm endpoints return 404', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-prepublish-'));
  temporaryDirectories.push(outputDirectory);
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
      return Response.json({ error: 'package not found' }, { status: 404 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        'draft.json',
        '--markdown',
        'draft.md',
      ],
      env: {
        GITHUB_TOKEN: 'read-only-test-token',
        GITHUB_SHA: '50d02d44abdbfb3489516f39f4251481dfec1548',
      },
      fetchImpl,
      now: new Date('2026-09-01T11:15:00.000Z'),
      workingDirectory: outputDirectory,
    }),
  ).resolves.toBeUndefined();

  const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
    generation: { status: string };
    ledger: {
      adoption: { metrics: Record<string, { value: unknown; status: string }> };
    };
    warnings: string[];
  };
  expect(draft.generation.status).toBe('partial');
  expect(draft.ledger.adoption.metrics.latestNpmVersion).toMatchObject({
    value: null,
    status: 'missing',
  });
  expect(draft.ledger.adoption.metrics.npmDownloadsLastMonth).toMatchObject({
    value: null,
    status: 'missing',
  });
  expect(draft.warnings).toEqual([
    'npm-package: missing; affected metrics remain null pending review',
    'npm-downloads: missing; affected metrics remain null pending review',
  ]);
});

it('rejects paired npm 404s after a public GitHub release has been observed', async () => {
  const runMonthlyEvidenceCli = await cliRunner();
  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-postpublish-'));
  temporaryDirectories.push(outputDirectory);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/releases?')) {
      return Response.json([
        {
          id: 801,
          tag_name: 'v0.1.0',
          published_at: '2026-08-25T00:00:00Z',
          draft: false,
        },
      ]);
    }
    if (
      url === 'https://registry.npmjs.org/scriptspect' ||
      url.endsWith('/downloads/point/last-month/scriptspect')
    ) {
      return Response.json({ error: 'package not found' }, { status: 404 });
    }
    return completeMonthlyResponse(url);
  }) as typeof fetch;

  await expect(
    runMonthlyEvidenceCli({
      argv: cliArguments(),
      env: { GITHUB_TOKEN: 'read-only-test-token' },
      fetchImpl,
      now: new Date('2026-09-01T11:15:30.000Z'),
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');

  const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
    ledger: {
      maintenance: { metrics: Record<string, { value: unknown; status: string }> };
    };
  };
  expect(draft.ledger.maintenance.metrics.publicReleases).toMatchObject({
    value: 1,
    status: 'observed',
  });
  expect(existsSync(join(outputDirectory, 'draft.md'))).toBe(true);
});

it.each([
  {
    sourceId: 'github-repository',
    matches: (url: string) => url === 'https://api.github.com/repos/Tom409114/scriptspect',
    invalidResponse: () => Response.json({ full_name: 42, stargazers_count: 0, forks_count: 0 }),
  },
  {
    sourceId: 'github-issues',
    matches: (url: string) => url.includes('/issues?'),
    invalidResponse: () => Response.json([{ id: 901, user: null }]),
  },
  {
    sourceId: 'github-releases',
    matches: (url: string) => url.includes('/releases?'),
    invalidResponse: () =>
      Response.json([{ id: 902, draft: 'false', published_at: '2026-08-25T00:00:00Z' }]),
  },
  {
    sourceId: 'github-actions-ci',
    matches: (url: string) => url.includes('/actions/workflows/ci.yml/runs?'),
    invalidResponse: () =>
      Response.json({
        total_count: 1,
        workflow_runs: [{ id: 903, status: 42, conclusion: 'success' }],
      }),
  },
  {
    sourceId: 'npm-package',
    matches: (url: string) => url === 'https://registry.npmjs.org/scriptspect',
    invalidResponse: () => Response.json({ name: 'scriptspect', 'dist-tags': { latest: 123 } }),
  },
  {
    sourceId: 'npm-downloads',
    matches: (url: string) => url.endsWith('/downloads/point/last-month/scriptspect'),
    invalidResponse: () => Response.json({ downloads: 'zero', package: 'scriptspect' }),
  },
])(
  'writes a partial draft before rejecting structurally invalid 2xx JSON from $sourceId',
  async ({ sourceId, matches, invalidResponse }) => {
    const runMonthlyEvidenceCli = await cliRunner();
    const outputDirectory = mkdtempSync(join(tmpdir(), `scriptspect-monthly-${sourceId}-shape-`));
    temporaryDirectories.push(outputDirectory);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      return matches(url) ? invalidResponse() : completeMonthlyResponse(url);
    }) as typeof fetch;

    await expect(
      runMonthlyEvidenceCli({
        argv: cliArguments(),
        env: { GITHUB_TOKEN: 'read-only-test-token' },
        fetchImpl,
        now: new Date('2026-09-01T11:15:45.000Z'),
        workingDirectory: outputDirectory,
      }),
    ).rejects.toThrow('Monthly evidence collection was partial');

    const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
      sources: Array<{ id: string; completeness: string; note: string }>;
    };
    expect(draft.sources.find(({ id }) => id === sourceId)).toMatchObject({
      completeness: 'partial',
      note: expect.stringMatching(/structurally invalid/iu),
    });
    expect(existsSync(join(outputDirectory, 'draft.md'))).toBe(true);
  },
);

it('stops slow pagination at the global deadline, writes a partial draft, and rejects', async () => {
  const runMonthlyEvidenceCli = await cliRunner();
  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-deadline-'));
  temporaryDirectories.push(outputDirectory);
  const requestedIssuePages: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/issues?')) return completeMonthlyResponse(url);
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') ?? '1');
    requestedIssuePages.push(page);
    const response = Response.json(
      [{ id: 1_000 + page, number: page, user: { login: 'outside', type: 'User' } }],
      {
        headers: {
          link: `<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`,
        },
      },
    );
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response), 15);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  }) as typeof fetch;

  await expect(
    runMonthlyEvidenceCli({
      argv: cliArguments(),
      env: { GITHUB_TOKEN: 'read-only-test-token' },
      fetchImpl,
      now: new Date('2026-09-01T11:15:50.000Z'),
      requestTimeoutMs: 1_000,
      collectionTimeoutMs: 40,
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');

  expect(requestedIssuePages.length).toBeGreaterThan(0);
  expect(requestedIssuePages.length).toBeLessThan(10);
  const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
    sources: Array<{ id: string; completeness: string; note: string }>;
  };
  expect(draft.sources.find(({ id }) => id === 'github-issues')).toMatchObject({
    completeness: 'partial',
    note: expect.stringMatching(/deadline/iu),
  });
  expect(existsSync(join(outputDirectory, 'draft.md'))).toBe(true);
});

it('rejects an inconsistent npm state instead of treating one package 404 as the pair', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-npm-mismatch-'));
  temporaryDirectories.push(outputDirectory);
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
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({ error: 'package not found' }, { status: 404 });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      return Response.json({ downloads: 12 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        'draft.json',
        '--markdown',
        'draft.md',
      ],
      env: { GITHUB_TOKEN: 'read-only-test-token' },
      fetchImpl,
      now: new Date('2026-09-01T11:16:00.000Z'),
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');
});

it('rejects paired 404 responses whose bodies are not valid JSON receipts', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-invalid-404-'));
  temporaryDirectories.push(outputDirectory);
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
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (
      url === 'https://registry.npmjs.org/scriptspect' ||
      url.endsWith('/downloads/point/last-month/scriptspect')
    ) {
      return new Response('<html>not found</html>', { status: 404 });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        'draft.json',
        '--markdown',
        'draft.md',
      ],
      env: { GITHUB_TOKEN: 'read-only-test-token' },
      fetchImpl,
      now: new Date('2026-09-01T11:17:00.000Z'),
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');

  const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
    sources: Array<{ id: string; completeness: string; httpStatus: number | null }>;
  };
  for (const sourceId of ['npm-package', 'npm-downloads']) {
    expect(draft.sources.find(({ id }) => id === sourceId)).toMatchObject({
      completeness: 'partial',
      httpStatus: 404,
    });
  }
});

it('aborts a stalled request, writes the partial draft, and then fails the CLI', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      requestTimeoutMs: number;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-timeout-'));
  temporaryDirectories.push(outputDirectory);
  let receivedAbortSignal = false;
  let requestWasAborted = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Tom409114/scriptspect') {
      return Response.json({
        full_name: 'Tom409114/scriptspect',
        stargazers_count: 0,
        forks_count: 0,
      });
    }
    if (url.includes('/issues?') || url.includes('/releases?')) return Response.json([]);
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (url === 'https://registry.npmjs.org/scriptspect') {
      return Response.json({ error: 'package not found' }, { status: 404 });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      receivedAbortSignal = init?.signal instanceof AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error('test fallback timeout')), 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(fallback);
            requestWasAborted = true;
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        'draft.json',
        '--markdown',
        'draft.md',
      ],
      env: { GITHUB_TOKEN: 'github_pat_TIMEOUT_MUST_NOT_LEAK_12345678901234567890' },
      fetchImpl,
      now: new Date('2026-09-01T11:18:00.000Z'),
      requestTimeoutMs: 5,
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');

  expect(receivedAbortSignal).toBe(true);
  expect(requestWasAborted).toBe(true);
  const combinedOutput = `${readFileSync(join(outputDirectory, 'draft.json'), 'utf8')}\n${readFileSync(join(outputDirectory, 'draft.md'), 'utf8')}`;
  expect(combinedOutput).toContain('npm-downloads: partial');
  expect(combinedOutput).not.toContain('TIMEOUT_MUST_NOT_LEAK');
});

it('keeps a real transport failure fatal even while the npm package is unpublished', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    runMonthlyEvidenceCli?: (options: {
      argv: string[];
      env: NodeJS.ProcessEnv;
      fetchImpl: typeof fetch;
      now: Date;
      workingDirectory: string;
    }) => Promise<void>;
  };
  expect(typeof module.runMonthlyEvidenceCli).toBe('function');
  if (!module.runMonthlyEvidenceCli) throw new Error('monthly evidence CLI was unavailable');

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-network-failure-'));
  temporaryDirectories.push(outputDirectory);
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
      return Response.json({ error: 'package not found' }, { status: 404 });
    }
    if (url.endsWith('/downloads/point/last-month/scriptspect')) {
      throw new Error('simulated socket failure');
    }
    return new Response('{"message":"unexpected URL"}', { status: 500 });
  }) as typeof fetch;

  await expect(
    module.runMonthlyEvidenceCli({
      argv: [
        '--repository',
        'Tom409114/scriptspect',
        '--package',
        'scriptspect',
        '--json',
        'draft.json',
        '--markdown',
        'draft.md',
      ],
      env: { GITHUB_TOKEN: 'read-only-test-token' },
      fetchImpl,
      now: new Date('2026-09-01T11:20:00.000Z'),
      workingDirectory: outputDirectory,
    }),
  ).rejects.toThrow('Monthly evidence collection was partial');

  const draft = JSON.parse(readFileSync(join(outputDirectory, 'draft.json'), 'utf8')) as {
    sources: Array<{ id: string; completeness: string; httpStatus: number | null }>;
  };
  expect(draft.sources.find(({ id }) => id === 'npm-package')).toMatchObject({
    completeness: 'missing',
    httpStatus: 404,
  });
  expect(draft.sources.find(({ id }) => id === 'npm-downloads')).toMatchObject({
    completeness: 'partial',
    httpStatus: null,
  });
});

itWithFileSymlinks(
  'rejects a final-component output symlink without overwriting its external target',
  async () => {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), 'tools', 'collect-monthly-evidence.ts'),
    ).href;
    const module = (await import(moduleUrl).catch(() => ({}))) as {
      writeMonthlyEvidenceDraft?: (
        draft: ReturnType<typeof draftFixture>,
        paths: { jsonPath: string; markdownPath: string; workingDirectory?: string },
      ) => void;
    };
    expect(typeof module.writeMonthlyEvidenceDraft).toBe('function');
    if (!module.writeMonthlyEvidenceDraft) {
      throw new Error('monthly evidence output function was unavailable');
    }

    const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-symlink-'));
    temporaryDirectories.push(outputDirectory);
    const workingDirectory = join(outputDirectory, 'workspace');
    mkdirSync(workingDirectory);
    const externalTarget = join(outputDirectory, 'external.json');
    const original = '{"outside":"must remain unchanged"}\n';
    writeFileSync(externalTarget, original, 'utf8');
    const jsonPath = join(workingDirectory, 'draft.json');
    const markdownPath = join(workingDirectory, 'draft.md');
    symlinkSync(externalTarget, jsonPath, 'file');

    expect(() =>
      module.writeMonthlyEvidenceDraft?.(draftFixture(), {
        jsonPath,
        markdownPath,
        workingDirectory,
      }),
    ).toThrow();
    expect(readFileSync(externalTarget, 'utf8')).toBe(original);
    expect(existsSync(markdownPath)).toBe(false);
  },
);

it('rejects an existing sibling output without leaving a partially written draft', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'tools', 'collect-monthly-evidence.ts')).href;
  const module = (await import(moduleUrl).catch(() => ({}))) as {
    writeMonthlyEvidenceDraft?: (
      draft: ReturnType<typeof draftFixture>,
      paths: { jsonPath: string; markdownPath: string; workingDirectory?: string },
    ) => void;
  };
  expect(typeof module.writeMonthlyEvidenceDraft).toBe('function');
  if (!module.writeMonthlyEvidenceDraft) {
    throw new Error('monthly evidence output function was unavailable');
  }

  const outputDirectory = mkdtempSync(join(tmpdir(), 'scriptspect-monthly-existing-'));
  temporaryDirectories.push(outputDirectory);
  const jsonPath = join(outputDirectory, 'draft.json');
  const markdownPath = join(outputDirectory, 'draft.md');
  const existing = 'maintainer-owned file\n';
  writeFileSync(markdownPath, existing, 'utf8');

  expect(() =>
    module.writeMonthlyEvidenceDraft?.(draftFixture(), {
      jsonPath,
      markdownPath,
      workingDirectory: outputDirectory,
    }),
  ).toThrow();
  expect(readFileSync(markdownPath, 'utf8')).toBe(existing);
  expect(existsSync(jsonPath)).toBe(false);
});
