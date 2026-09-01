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
        completeness: 'partial',
        httpStatus: 200,
        response: {
          sha256: 'a'.repeat(64),
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
