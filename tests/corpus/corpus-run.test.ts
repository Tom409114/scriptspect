import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorpusLimits, DEFAULT_CORPUS_LIMITS, type TreeEntry } from '../../tools/corpus-lib';
import { corpusScanOptionsFromCli, runCorpusScan } from '../../tools/corpus-scan';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_COMMIT = '89abcdef0123456789abcdef0123456789abcdef';
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-corpus-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface GitHubObservation {
  rawUrls: string[];
  rawAuthorization: Array<string | null>;
  rawRedirect: Array<RequestInit['redirect']>;
}

type RawResponseFactory = (path: string, bytes: Buffer) => Response;

function fixtureGitBlobOid(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function authorizationHeader(input: string | URL | Request, init?: RequestInit): string | null {
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  return new Headers(init?.headers ?? inputHeaders).get('authorization');
}

function fakeGitHub(
  tree: TreeEntry[],
  blobs: Record<string, Buffer>,
  observation: GitHubObservation = { rawUrls: [], rawAuthorization: [], rawRedirect: [] },
  rawResponse: RawResponseFactory = (_path, bytes) => new Response(bytes),
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/git/trees/')) {
      return Response.json({ tree, truncated: false });
    }
    const parsed = new URL(url);
    if (parsed.hostname !== 'raw.githubusercontent.com') {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    observation.rawUrls.push(url);
    observation.rawAuthorization.push(authorizationHeader(input, init));
    observation.rawRedirect.push(init?.redirect);
    const [, owner, repository, commit, ...encodedPath] = parsed.pathname.split('/');
    if (owner !== 'example' || repository !== 'project' || commit !== COMMIT) {
      return new Response('missing', { status: 404 });
    }
    const path = encodedPath.map(decodeURIComponent).join('/');
    const bytes = blobs[path];
    if (bytes === undefined) return new Response('missing', { status: 404 });
    return rawResponse(path, bytes);
  }) as typeof fetch;
}

function fixture(): { tree: TreeEntry[]; blobs: Record<string, Buffer>; rawScript: string } {
  const rawScript = 'rm -rf dist && echo CORPUS_PRIVATE_SENTINEL_7f86';
  const root = Buffer.from(
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      scripts: { clean: rawScript },
    }),
  );
  const child = Buffer.from(
    JSON.stringify({ name: '@fixture/child', scripts: { clean: 'rm -rf lib' } }),
  );
  return {
    rawScript,
    tree: [
      {
        path: 'package.json',
        type: 'blob',
        mode: '100644',
        size: root.length,
        sha: fixtureGitBlobOid(root),
      },
      {
        path: 'packages/child/package.json',
        type: 'blob',
        mode: '100644',
        size: child.length,
        sha: fixtureGitBlobOid(child),
      },
      {
        path: 'node_modules/leak/package.json',
        type: 'blob',
        mode: '100644',
        size: 10,
        sha: 'excluded',
      },
    ],
    blobs: { 'package.json': root, 'packages/child/package.json': child },
  };
}

function sensitiveDiagnosticFixture(): {
  tree: TreeEntry[];
  blobs: Record<string, Buffer>;
  sentinels: string[];
} {
  const sentinels = [
    'CORPUS_ENV_SENTINEL_a71f',
    'CORPUS_SUBSTITUTION_SENTINEL_b82e',
    'CORPUS_CMD_SENTINEL_c93d',
  ];
  const root = Buffer.from(
    JSON.stringify({
      name: 'sensitive-message-fixture',
      scripts: {
        env: `echo $${sentinels[0]}`,
        substitution: `echo $(printf ${sentinels[1]})`,
        cmd: `echo %${sentinels[2]}%`,
      },
    }),
  );
  return {
    sentinels,
    tree: [
      {
        path: 'package.json',
        type: 'blob',
        mode: '100644',
        size: root.length,
        sha: fixtureGitBlobOid(root),
      },
    ],
    blobs: { 'package.json': root },
  };
}

function completeCandidateSnapshot(): Record<string, unknown> {
  return {
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
        responseSha256: 'a'.repeat(64),
        candidates: [{ rank: 1, repository: 'example/project', stars: 10_000 }],
      },
      {
        id: 'javascript',
        query: 'is:public language:javascript stars:>5000',
        sort: 'stars',
        order: 'desc',
        perPage: 100,
        responseSha256: 'b'.repeat(64),
        candidates: [],
      },
    ],
    orderedCandidates: [
      { position: 1, stratum: 'typescript', rank: 1, repository: 'example/project' },
    ],
  };
}

function completeSampleEvidence(
  candidateSnapshot: Buffer,
  rootManifestOid: string,
  rootManifestBytes: number,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    method: 'popularity-strata-round-robin-v1',
    candidateSnapshotSha256: createHash('sha256').update(candidateSnapshot).digest('hex'),
    requested: 1,
    actual: 1,
    candidatesConsidered: 1,
    status: 'complete',
    api: {
      transport: 'github-graphql-batch-v1',
      batchSize: 20,
      requests: 1,
      cost: 1,
      rateLimit: {
        limit: 5000,
        remaining: 4999,
        used: 1,
        resetAt: '2026-09-01T01:00:00Z',
      },
    },
    selected: [
      {
        position: 1,
        stratum: 'typescript',
        rank: 1,
        repository: 'example/project',
        commit: COMMIT,
        rootManifestOid,
        rootManifestBytes,
      },
    ],
    exclusions: [],
  };
}

function completeProvenance(data: ReturnType<typeof fixture>): {
  candidateSnapshot: Buffer;
  sampleEvidence: Record<string, unknown>;
} {
  const candidateSnapshot = Buffer.from(
    `${JSON.stringify(completeCandidateSnapshot(), null, 2)}\n`,
    'utf8',
  );
  const root = data.tree.find((entry) => entry.path === 'package.json');
  if (root?.size === undefined) throw new Error('test root manifest fixture was incomplete');
  return {
    candidateSnapshot,
    sampleEvidence: completeSampleEvidence(candidateSnapshot, root.sha, root.size),
  };
}

function git(directory: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', directory, ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function posixShell(): string {
  if (process.platform !== 'win32') return 'sh';
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const gitRoot = dirname(dirname(dirname(gitExecPath)));
  return join(gitRoot, 'bin', 'sh.exe');
}

async function replayFixture(
  options: { limits?: CorpusLimits; runnerOs?: string } = {},
): Promise<{ directory: string; reproduction: string }> {
  const directory = temporaryDirectory();
  const outputRoot = temporaryDirectory();
  mkdirSync(join(directory, 'tools'), { recursive: true });
  writeFileSync(join(directory, 'tools', 'corpus-scan.ts'), 'export const committed = true;\n');
  writeFileSync(join(directory, 'package.json'), '{"packageManager":"pnpm@11.24.0"}\n');
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.name', 'Corpus Replay Test');
  git(directory, 'config', 'user.email', 'corpus-replay@example.invalid');
  git(directory, 'config', 'core.autocrlf', 'false');
  git(directory, 'add', '--', 'tools/corpus-scan.ts', 'package.json');
  git(directory, 'commit', '--quiet', '-m', 'fixture');
  const sourceCommit = git(directory, 'rev-parse', 'HEAD');
  const inputFile = join(directory, 'repos.txt');
  const candidateSnapshotFile = join(directory, 'repository-candidates.json');
  const sampleEvidenceFile = join(directory, 'repository-sample.json');
  const data = fixture();
  const provenance = completeProvenance(data);
  writeFileSync(inputFile, `example/project@${COMMIT}\n`);
  writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);
  writeFileSync(
    sampleEvidenceFile,
    `${JSON.stringify(provenance.sampleEvidence, null, 2)}\n`,
    'utf8',
  );

  const previousRunnerOs = process.env.RUNNER_OS;
  if (options.runnerOs === undefined) delete process.env.RUNNER_OS;
  else process.env.RUNNER_OS = options.runnerOs;
  try {
    const manifest = await runCorpusScan({
      inputFile,
      outputDir: join(outputRoot, 'initial-output'),
      token: 'read-only-test-token-must-not-be-persisted',
      sourceCommit,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
      limits: options.limits,
      sampleMethod: 'popularity-strata-round-robin-v1',
      sampleSeed: 'candidate-seed',
      candidateSnapshotFile,
      sampleEvidenceFile,
    });
    return { directory, reproduction: manifest.reproduction };
  } finally {
    if (previousRunnerOs === undefined) delete process.env.RUNNER_OS;
    else process.env.RUNNER_OS = previousRunnerOs;
  }
}

function executeReplay(
  directory: string,
  reproduction: string,
  options: { shellSetup?: string; runnerOs?: string } = {},
): ReturnType<typeof spawnSync> {
  const script = [
    'corepack() { return 0; }',
    [
      'pnpm() {',
      '  if [ "$1" = "exec" ]; then',
      `    printf "RUNNER_OS=%s\\n" "\${RUNNER_OS-<unset>}" > replay-observation.txt`,
      `    printf "CORPUS_LIMITS_JSON=%s\\n" "\${CORPUS_LIMITS_JSON-<unset>}" >> replay-observation.txt`,
      '    printf "ARGS=" >> replay-observation.txt',
      '    printf "<%s>" "$@" >> replay-observation.txt',
      '    printf "\\n" >> replay-observation.txt',
      '  fi',
      '  return 0',
      '}',
    ].join('\n'),
    options.shellSetup ?? '',
    reproduction,
  ].join('\n');
  return spawnSync(posixShell(), ['-c', script], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_TOKEN: 'ephemeral-replay-test-token',
      ...(options.runnerOs === undefined ? {} : { RUNNER_OS: options.runnerOs }),
    },
  });
}

describe('immutable corpus run evidence', () => {
  it('uses canonical workspace analysis while persisting hashes instead of script source', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const observation: GitHubObservation = { rawUrls: [], rawAuthorization: [], rawRedirect: [] };
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs, observation),
    });

    expect(manifest.repositories).toMatchObject([
      {
        repository: 'example/project',
        commit: COMMIT,
        status: 'complete',
        manifestPaths: ['package.json', 'packages/child/package.json'],
        rootOnly: { packages: 1, scripts: 1 },
        workspaceFull: { packages: 2, scripts: 2 },
      },
    ]);
    expect(manifest.promotedTotals.workspaceFull).toMatchObject({ repositories: 1, packages: 2 });

    const findingsText = readFileSync(join(outputDir, 'findings.jsonl'), 'utf8');
    const evidence = findingsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((finding) => !('source' in finding) && !('script' in finding))).toBe(
      true,
    );
    expect(evidence.every((finding) => typeof finding.scriptSha256 === 'string')).toBe(true);
    expect(evidence.every((finding) => String(finding.url).includes(COMMIT))).toBe(true);
    expect(findingsText).not.toContain(data.rawScript);
    expect(findingsText).not.toContain('CORPUS_PRIVATE_SENTINEL_7f86');
    expect(observation.rawUrls).toEqual([
      `https://raw.githubusercontent.com/example/project/${COMMIT}/package.json`,
      `https://raw.githubusercontent.com/example/project/${COMMIT}/packages/child/package.json`,
    ]);
    expect(observation.rawAuthorization).toEqual([null, null]);
    expect(observation.rawRedirect).toEqual(['error', 'error']);

    const persisted = JSON.parse(
      readFileSync(join(outputDir, 'corpus-run.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      sourceCommit: SOURCE_COMMIT,
      mode: 'root-and-workspace',
      artifactSha256: {
        'findings.jsonl': expect.stringMatching(/^[a-f0-9]{64}$/),
        'summary.md': expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('uses source-free corpus messages for arbitrary environment and substitution findings', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = sensitiveDiagnosticFixture();
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
    });

    const findingsText = readFileSync(join(outputDir, 'findings.jsonl'), 'utf8');
    const findings = findingsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ruleId: string; message: string });
    expect(findings.length).toBeGreaterThan(0);
    for (const sentinel of data.sentinels) expect(findingsText).not.toContain(sentinel);
    expect(
      findings.every(
        (finding) =>
          finding.message === `${finding.ruleId} matched a portability rule at the recorded span.`,
      ),
    ).toBe(true);
  });

  it('makes truncation explicit and excludes the repository from promoted totals', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const observation: GitHubObservation = { rawUrls: [], rawAuthorization: [], rawRedirect: [] };
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs, observation),
      limits: { ...DEFAULT_CORPUS_LIMITS, maxManifests: 1 },
    });

    expect(manifest.repositories[0]).toMatchObject({
      status: 'truncated',
      truncations: ['manifest-limit:1'],
    });
    expect(manifest.promotedTotals.workspaceFull).toEqual({
      repositories: 0,
      packages: 0,
      scripts: 0,
      findings: 0,
    });
    expect(readFileSync(join(outputDir, 'findings.jsonl'), 'utf8')).toBe('');
    expect(observation.rawUrls).toEqual([]);
  });

  it.each([
    { name: 'missing', payload: (tree: TreeEntry[]) => ({ tree }) },
    { name: 'string', payload: (tree: TreeEntry[]) => ({ tree, truncated: 'false' }) },
    { name: 'null', payload: (tree: TreeEntry[]) => ({ tree, truncated: null }) },
  ])('fails closed when tree truncated is $name', async ({ payload }) => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const observation: GitHubObservation = { rawUrls: [], rawAuthorization: [], rawRedirect: [] };
    const rawApi = fakeGitHub(data.tree, data.blobs, observation);
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
          String(input).includes('/git/trees/')
            ? Response.json(payload(data.tree))
            : rawApi(input, init)) as typeof fetch,
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; failure?: { kind?: string } }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      failure: { kind: 'response-invalid' },
    });
    expect(observation.rawUrls).toEqual([]);
  });

  it('classifies a truncated GitHub tree without a root manifest as truncated', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    let rawCalled = false;
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).includes('/git/trees/')) {
          return Response.json({
            tree: data.tree.filter((entry) => entry.path !== 'package.json'),
            truncated: true,
          });
        }
        rawCalled = true;
        return new Response('unexpected');
      }) as typeof fetch,
    });

    expect(manifest.repositories[0]).toMatchObject({
      status: 'truncated',
      truncations: ['github-tree-truncated'],
    });
    expect(manifest.promotedTotals.workspaceFull.repositories).toBe(0);
    expect(rawCalled).toBe(false);
  });

  it('fails closed when raw bytes do not match the immutable tree blob OID', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const tamperedRoot = Buffer.from(data.blobs['package.json'] as Buffer);
    const rootNameOffset = tamperedRoot.indexOf('root');
    tamperedRoot.write('soot', rootNameOffset, 'utf8');
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: fakeGitHub(data.tree, {
          ...data.blobs,
          'package.json': tamperedRoot,
        }),
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; error?: string }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      error: 'package.json: raw bytes did not match the immutable tree Git blob OID',
    });
  });

  it('fails closed when raw byte length does not match the immutable tree entry', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const tree = data.tree.map((entry) =>
      entry.path === 'package.json' ? { ...entry, size: (entry.size as number) + 1 } : entry,
    );
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: fakeGitHub(tree, data.blobs),
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; error?: string }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      error: 'package.json: raw byte length did not match the immutable tree entry',
    });
  });

  it('rejects a non-SHA-1 tree blob OID before trusting raw content', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    const tree = data.tree.map((entry) =>
      entry.path === 'package.json' ? { ...entry, sha: 'a'.repeat(64) } : entry,
    );
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: fakeGitHub(tree, data.blobs),
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; error?: string }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      error: 'package.json: immutable tree Git blob OID was not 40 lowercase hex characters',
    });
  });

  it('cancels raw streaming as soon as bytes exceed the immutable tree size', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    let pulls = 0;
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: fakeGitHub(
          data.tree,
          data.blobs,
          { rawUrls: [], rawAuthorization: [], rawRedirect: [] },
          (path, bytes) => {
            if (path !== 'package.json') return new Response(bytes);
            const body = new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls += 1;
                  if (pulls === 1) controller.enqueue(bytes);
                  else if (pulls === 2) controller.enqueue(Uint8Array.of(0));
                  else controller.error(new Error('unbounded raw read sentinel'));
                },
              },
              { highWaterMark: 0 },
            );
            return new Response(body);
          },
        ),
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; error?: string }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      error: 'package.json: raw byte length did not match the immutable tree entry',
    });
    expect(pulls).toBe(2);
  });

  it('persists rate-limit classification and response headers for tree API failures', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        generatedAt: '2026-09-01T00:00:00.000Z',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'retry-after': '60',
              'x-github-request-id': 'TEST:RATE:123',
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1788213600',
              'x-ratelimit-resource': 'core',
              'x-ratelimit-used': '5000',
            },
          })) as typeof fetch,
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persistedText = readFileSync(join(outputDir, 'corpus-run.json'), 'utf8');
    const persisted = JSON.parse(persistedText) as {
      repositories: Array<{ failure?: unknown }>;
    };
    expect(persisted.repositories[0]?.failure).toEqual({
      kind: 'primary-rate-limit-exhausted',
      status: 403,
      url: `https://api.github.com/repos/example/project/git/trees/${COMMIT}?recursive=1`,
      rateLimit: {
        limit: '5000',
        remaining: '0',
        reset: '1788213600',
        used: '5000',
        resource: 'core',
      },
      retryAfter: '60',
      requestId: 'TEST:RATE:123',
    });
    expect(persistedText).not.toContain('read-only-test-token');
  });

  it('preserves response headers when tree JSON or shape is invalid', async () => {
    for (const body of ['not-json', JSON.stringify({ truncated: false })]) {
      const directory = temporaryDirectory();
      const inputFile = join(directory, 'repos.txt');
      const outputDir = join(directory, 'out');
      writeFileSync(inputFile, `example/project@${COMMIT}\n`);

      await expect(
        runCorpusScan({
          inputFile,
          outputDir,
          token: 'read-only-test-token',
          sourceCommit: SOURCE_COMMIT,
          generatedAt: '2026-09-01T00:00:00.000Z',
          fetchImpl: (async () =>
            new Response(body, {
              status: 200,
              headers: {
                'x-github-request-id': 'TEST:INVALID:123',
                'x-ratelimit-limit': '5000',
                'x-ratelimit-remaining': '4999',
                'x-ratelimit-reset': '1788213600',
                'x-ratelimit-resource': 'core',
                'x-ratelimit-used': '1',
              },
            })) as typeof fetch,
        }),
      ).rejects.toThrow('one or more repositories failed');

      const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
        repositories: Array<{ failure?: unknown }>;
      };
      expect(persisted.repositories[0]?.failure).toEqual({
        kind: 'response-invalid',
        status: 200,
        url: `https://api.github.com/repos/example/project/git/trees/${COMMIT}?recursive=1`,
        rateLimit: {
          limit: '5000',
          remaining: '4999',
          reset: '1788213600',
          used: '1',
          resource: 'core',
        },
        retryAfter: null,
        requestId: 'TEST:INVALID:123',
      });
    }
  });

  it('hashes the complete candidate snapshot and sample evidence into the run manifest', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const candidateSnapshotFile = join(directory, 'repository-candidates.json');
    const sampleEvidenceFile = join(directory, 'repository-sample.json');
    const data = fixture();
    const provenance = completeProvenance(data);
    const candidateSnapshot = provenance.candidateSnapshot;
    const candidateSnapshotSha256 = createHash('sha256').update(candidateSnapshot).digest('hex');
    const sampleEvidence = Buffer.from(
      `${JSON.stringify(provenance.sampleEvidence, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);
    writeFileSync(candidateSnapshotFile, candidateSnapshot);
    writeFileSync(sampleEvidenceFile, sampleEvidence);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
      sampleMethod: 'popularity-strata-round-robin-v1',
      candidateSnapshotFile,
      sampleEvidenceFile,
    });

    const sampleEvidenceSha256 = createHash('sha256').update(sampleEvidence).digest('hex');
    expect(manifest.sampling).toEqual({
      method: 'popularity-strata-round-robin-v1',
      seed: 'none',
      candidateSnapshotSha256,
      sampleEvidenceSha256,
    });
    expect(manifest.artifactSha256).toMatchObject({
      'repository-candidates.json': candidateSnapshotSha256,
      'repository-sample.json': sampleEvidenceSha256,
    });
  });

  it('emits a safe path-independent replay command for the complete provenance contract', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos copy.txt');
    const outputDir = join(directory, 'initial output');
    const candidateSnapshotFile = join(directory, "repository candidate's.json");
    const sampleEvidenceFile = join(directory, 'repository sample;ignored.json');
    const data = fixture();
    const provenance = completeProvenance(data);
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);
    writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);
    writeFileSync(
      sampleEvidenceFile,
      `${JSON.stringify(provenance.sampleEvidence, null, 2)}\n`,
      'utf8',
    );

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token-must-not-be-persisted',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
      sampleMethod: 'popularity-strata-round-robin-v1',
      sampleSeed: 'candidate-seed',
      candidateSnapshotFile,
      sampleEvidenceFile,
    });

    const replayOutput = `corpus-reproduction-${SOURCE_COMMIT}`;
    const cleanCheckout = [
      `test "$(git rev-parse --verify HEAD)" = '${SOURCE_COMMIT}'`,
      'git ls-files -v >/dev/null',
      'git ls-files -v | while IFS= read -r entry; do case "$entry" in H\\ *) ;; *) exit 1 ;; esac; done',
      'git diff --quiet --',
      'git diff --cached --quiet --',
      `test -z "$(git status --porcelain=v1 --untracked-files=all -- '.' ':(top,literal,exclude)repos copy.txt' ':(top,literal,exclude)repository candidate'"'"'s.json' ':(top,literal,exclude)repository sample;ignored.json')"`,
    ];
    expect(manifest.reproduction).toBe(
      [
        `: "\${GITHUB_TOKEN:?set GITHUB_TOKEN to a read-only public-repository token}"`,
        `git -c advice.detachedHead=false checkout --detach '${SOURCE_COMMIT}'`,
        ...cleanCheckout,
        `test "$(node --version)" = '${process.version}'`,
        `test "$(node -p 'process.platform')" = '${process.platform}'`,
        `test "$(node -p 'process.arch')" = '${process.arch}'`,
        'corepack enable',
        "corepack prepare 'pnpm@11.24.0' --activate",
        'pnpm install --frozen-lockfile',
        ...cleanCheckout,
        `test ! -e '${replayOutput}'`,
        `mkdir -- '${replayOutput}'`,
        'unset RUNNER_OS',
        `SCRIPTSPECT_SOURCE_COMMIT='${SOURCE_COMMIT}' CORPUS_GENERATED_AT='2026-09-01T00:00:00.000Z' CORPUS_SAMPLE_METHOD='popularity-strata-round-robin-v1' CORPUS_SAMPLE_SEED='candidate-seed' CORPUS_LIMITS_JSON='{"maxTreeEntries":20000,"maxManifests":500,"maxDepth":12,"maxFileBytes":1048576,"maxTotalBytes":10485760}' CORPUS_CANDIDATE_SNAPSHOT='repository candidate'"'"'s.json' CORPUS_SAMPLE_EVIDENCE='repository sample;ignored.json' pnpm exec tsx tools/corpus-scan.ts 'repos copy.txt' '${replayOutput}'`,
      ].join(' && '),
    );
    expect(manifest.reproduction).not.toContain('read-only-test-token-must-not-be-persisted');
    expect(manifest.reproduction).not.toContain(directory);
  });

  it('fails closed before scanning a checkout with dirty tracked, staged, or untracked files', async () => {
    const cases = [
      {
        name: 'tracked worktree',
        dirty: (directory: string) => {
          writeFileSync(join(directory, 'tools', 'corpus-scan.ts'), 'export const dirty = true;\n');
        },
      },
      {
        name: 'staged index',
        dirty: (directory: string) => {
          writeFileSync(
            join(directory, 'tools', 'corpus-scan.ts'),
            'export const staged = true;\n',
          );
          git(directory, 'add', '--', 'tools/corpus-scan.ts');
        },
      },
      {
        name: 'nonignored untracked code',
        dirty: (directory: string) => {
          writeFileSync(join(directory, 'rogue-config.ts'), 'export const rogue = true;\n');
        },
      },
    ];

    for (const testCase of cases) {
      const replay = await replayFixture();
      testCase.dirty(replay.directory);

      const result = executeReplay(replay.directory, replay.reproduction);

      expect(result.status, `${testCase.name}: ${result.stderr}`).not.toBe(0);
      expect(existsSync(join(replay.directory, 'replay-observation.txt'))).toBe(false);
    }
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ])('fails closed when %s hides a dirty tracked scanner', async (_name, indexFlag) => {
    const replay = await replayFixture();
    git(replay.directory, 'update-index', indexFlag, '--', 'tools/corpus-scan.ts');
    writeFileSync(
      join(replay.directory, 'tools', 'corpus-scan.ts'),
      'export const hiddenDirtyScanner = true;\n',
    );

    const result = executeReplay(replay.directory, replay.reproduction);

    expect(result.status, String(result.stderr)).not.toBe(0);
    expect(existsSync(join(replay.directory, 'replay-observation.txt'))).toBe(false);
  });

  it('fails closed before scanning under a different Node runtime', async () => {
    const cases = [
      { name: 'version', version: 'v0.0.0', platform: process.platform, arch: process.arch },
      { name: 'platform', version: process.version, platform: 'foreign-os', arch: process.arch },
      {
        name: 'architecture',
        version: process.version,
        platform: process.platform,
        arch: 'foreign-arch',
      },
    ];

    for (const testCase of cases) {
      const replay = await replayFixture();
      const shellSetup = [
        'node() {',
        `  if [ "$1" = "--version" ]; then printf '%s\\n' '${testCase.version}'`,
        `  elif [ "$1" = "-p" ] && [ "$2" = "process.platform" ]; then printf '%s\\n' '${testCase.platform}'`,
        `  elif [ "$1" = "-p" ] && [ "$2" = "process.arch" ]; then printf '%s\\n' '${testCase.arch}'`,
        '  else return 64',
        '  fi',
        '}',
      ].join('\n');

      const result = executeReplay(replay.directory, replay.reproduction, { shellSetup });

      expect(result.status, `${testCase.name}: ${result.stderr}`).not.toBe(0);
      expect(existsSync(join(replay.directory, 'replay-observation.txt'))).toBe(false);
    }
  });

  it('restores defined and unset RUNNER_OS state plus exact default and custom limits', async () => {
    const customLimits: CorpusLimits = {
      maxTotalBytes: 50_000,
      maxFileBytes: 4_000,
      maxDepth: 3,
      maxManifests: 2,
      maxTreeEntries: 100,
    };
    const cases = [
      {
        name: 'unset runner and default limits',
        replay: await replayFixture(),
        outerRunnerOs: 'ConflictingRunner',
        expectedRunnerOs: '<unset>',
        expectedLimits: DEFAULT_CORPUS_LIMITS,
      },
      {
        name: 'defined runner and custom limits',
        replay: await replayFixture({ limits: customLimits, runnerOs: 'RecordedRunner' }),
        outerRunnerOs: 'ConflictingRunner',
        expectedRunnerOs: 'RecordedRunner',
        expectedLimits: customLimits,
      },
    ];

    for (const testCase of cases) {
      const result = executeReplay(testCase.replay.directory, testCase.replay.reproduction, {
        runnerOs: testCase.outerRunnerOs,
      });

      expect(result.status, `${testCase.name}: ${result.stderr}`).toBe(0);
      const observation = readFileSync(
        join(testCase.replay.directory, 'replay-observation.txt'),
        'utf8',
      );
      expect(observation).toContain(`RUNNER_OS=${testCase.expectedRunnerOs}\n`);
      expect(observation).toContain(
        `CORPUS_LIMITS_JSON=${JSON.stringify({
          maxTreeEntries: testCase.expectedLimits.maxTreeEntries,
          maxManifests: testCase.expectedLimits.maxManifests,
          maxDepth: testCase.expectedLimits.maxDepth,
          maxFileBytes: testCase.expectedLimits.maxFileBytes,
          maxTotalBytes: testCase.expectedLimits.maxTotalBytes,
        })}\n`,
      );
      expect(observation).toContain(
        `<exec><tsx><tools/corpus-scan.ts><repos.txt><corpus-reproduction-${git(
          testCase.replay.directory,
          'rev-parse',
          'HEAD',
        )}>`,
      );
      expect(testCase.replay.reproduction).not.toContain('ephemeral-replay-test-token');
      expect(testCase.replay.reproduction).not.toContain(testCase.replay.directory);
    }
  });

  it('parses default and exact custom limits from the scanner CLI environment', () => {
    const baseEnvironment = {
      GITHUB_TOKEN: 'read-only-test-token',
      SCRIPTSPECT_SOURCE_COMMIT: SOURCE_COMMIT,
    };
    const defaults = corpusScanOptionsFromCli(['repos.txt', 'default-output'], baseEnvironment);
    expect(defaults).toMatchObject({
      inputFile: 'repos.txt',
      outputDir: 'default-output',
      limits: DEFAULT_CORPUS_LIMITS,
    });

    const customJson =
      '{"maxTotalBytes":50000,"maxDepth":3,"maxTreeEntries":100,"maxFileBytes":4000,"maxManifests":2}';
    const custom = corpusScanOptionsFromCli(['repos.txt', 'custom-output'], {
      ...baseEnvironment,
      CORPUS_LIMITS_JSON: customJson,
    });
    expect(JSON.stringify(custom.limits)).toBe(
      '{"maxTreeEntries":100,"maxManifests":2,"maxDepth":3,"maxFileBytes":4000,"maxTotalBytes":50000}',
    );

    for (const malformed of [
      '{}',
      '[]',
      '{"maxTreeEntries":1,"maxManifests":2,"maxDepth":3,"maxFileBytes":4,"maxTotalBytes":5,"extra":6}',
      '{"maxTreeEntries":1,"maxManifests":2,"maxDepth":-1,"maxFileBytes":4,"maxTotalBytes":5}',
      '{"maxTreeEntries":1,"maxManifests":2,"maxDepth":3.5,"maxFileBytes":4,"maxTotalBytes":5}',
      'not-json',
    ]) {
      expect(() =>
        corpusScanOptionsFromCli(['repos.txt'], {
          ...baseEnvironment,
          CORPUS_LIMITS_JSON: malformed,
        }),
      ).toThrow(/CORPUS_LIMITS_JSON/);
    }
  });

  it('rejects mismatched sample provenance before making a network request', async () => {
    const data = fixture();
    const provenance = completeProvenance(data);
    const cases = [
      {
        name: 'status',
        mutate: (evidence: Record<string, unknown>) => {
          evidence.status = 'failed';
        },
      },
      {
        name: 'method',
        mutate: (evidence: Record<string, unknown>) => {
          evidence.method = 'wrong-method';
        },
      },
      {
        name: 'candidate snapshot digest',
        mutate: (evidence: Record<string, unknown>) => {
          evidence.candidateSnapshotSha256 = '0'.repeat(64);
        },
      },
      {
        name: 'selected locator sequence',
        mutate: (evidence: Record<string, unknown>) => {
          const selected = evidence.selected as Array<Record<string, unknown>>;
          const first = selected[0];
          if (first === undefined) throw new Error('sample evidence test fixture was incomplete');
          first.repository = 'another/project';
        },
      },
    ];

    for (const testCase of cases) {
      const directory = temporaryDirectory();
      const inputFile = join(directory, 'repos.txt');
      const outputDir = join(directory, 'out');
      const candidateSnapshotFile = join(directory, 'repository-candidates.json');
      const sampleEvidenceFile = join(directory, 'repository-sample.json');
      const evidence = structuredClone(provenance.sampleEvidence);
      testCase.mutate(evidence);
      let networkCalled = false;
      writeFileSync(inputFile, `example/project@${COMMIT}\n`);
      writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);
      writeFileSync(sampleEvidenceFile, `${JSON.stringify(evidence)}\n`, 'utf8');
      const upstream = fakeGitHub(data.tree, data.blobs);

      await expect(
        runCorpusScan({
          inputFile,
          outputDir,
          token: 'read-only-test-token',
          sourceCommit: SOURCE_COMMIT,
          generatedAt: '2026-09-01T00:00:00.000Z',
          fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
            networkCalled = true;
            return upstream(input, init);
          }) as typeof fetch,
          sampleMethod: 'popularity-strata-round-robin-v1',
          candidateSnapshotFile,
          sampleEvidenceFile,
        }),
      ).rejects.toThrow(/corpus sample evidence/);
      expect(networkCalled, testCase.name).toBe(false);
    }
  });

  it('rejects malformed candidate snapshot structure before making a network request', async () => {
    const data = fixture();
    const cases = [
      {
        name: 'schema',
        mutate: (snapshot: Record<string, unknown>) => {
          snapshot.schemaVersion = 99;
        },
      },
      {
        name: 'stratum metadata',
        mutate: (snapshot: Record<string, unknown>) => {
          const strata = snapshot.strata as Array<Record<string, unknown>>;
          const first = strata[0];
          if (first === undefined)
            throw new Error('candidate snapshot test fixture was incomplete');
          first.query = 'language:typescript';
        },
      },
      {
        name: 'ordered universe',
        mutate: (snapshot: Record<string, unknown>) => {
          snapshot.orderedCandidates = [];
        },
      },
    ];

    for (const testCase of cases) {
      const directory = temporaryDirectory();
      const inputFile = join(directory, 'repos.txt');
      const candidateSnapshotFile = join(directory, 'repository-candidates.json');
      const sampleEvidenceFile = join(directory, 'repository-sample.json');
      const snapshot = completeCandidateSnapshot();
      testCase.mutate(snapshot);
      const candidateSnapshot = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
      const root = data.tree.find((entry) => entry.path === 'package.json');
      if (root?.size === undefined) throw new Error('test root manifest fixture was incomplete');
      const evidence = completeSampleEvidence(candidateSnapshot, root.sha, root.size);
      let networkCalled = false;
      writeFileSync(inputFile, `example/project@${COMMIT}\n`);
      writeFileSync(candidateSnapshotFile, candidateSnapshot);
      writeFileSync(sampleEvidenceFile, `${JSON.stringify(evidence)}\n`, 'utf8');

      await expect(
        runCorpusScan({
          inputFile,
          outputDir: join(directory, 'out'),
          token: 'read-only-test-token',
          sourceCommit: SOURCE_COMMIT,
          fetchImpl: (async () => {
            networkCalled = true;
            return new Response('unexpected');
          }) as typeof fetch,
          candidateSnapshotFile,
          sampleEvidenceFile,
        }),
      ).rejects.toThrow(/candidate snapshot/);
      expect(networkCalled, testCase.name).toBe(false);
    }
  });

  it('rejects incomplete sample evidence structure before making a network request', async () => {
    const data = fixture();
    const provenance = completeProvenance(data);
    const cases = [
      {
        name: 'schemaVersion',
        mutate: (evidence: Record<string, unknown>) => {
          delete evidence.schemaVersion;
        },
      },
      {
        name: 'requested/actual contract',
        mutate: (evidence: Record<string, unknown>) => {
          evidence.requested = 2;
        },
      },
      {
        name: 'api',
        mutate: (evidence: Record<string, unknown>) => {
          delete evidence.api;
        },
      },
      {
        name: 'exclusions',
        mutate: (evidence: Record<string, unknown>) => {
          evidence.exclusions = [{}];
        },
      },
      {
        name: 'root manifest identity',
        mutate: (evidence: Record<string, unknown>) => {
          const selected = evidence.selected as Array<Record<string, unknown>>;
          const first = selected[0];
          if (first === undefined) throw new Error('sample evidence test fixture was incomplete');
          delete first.rootManifestOid;
        },
      },
    ];

    for (const testCase of cases) {
      const directory = temporaryDirectory();
      const inputFile = join(directory, 'repos.txt');
      const candidateSnapshotFile = join(directory, 'repository-candidates.json');
      const sampleEvidenceFile = join(directory, 'repository-sample.json');
      const evidence = structuredClone(provenance.sampleEvidence);
      testCase.mutate(evidence);
      let networkCalled = false;
      writeFileSync(inputFile, `example/project@${COMMIT}\n`);
      writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);
      writeFileSync(sampleEvidenceFile, `${JSON.stringify(evidence)}\n`, 'utf8');

      await expect(
        runCorpusScan({
          inputFile,
          outputDir: join(directory, 'out'),
          token: 'read-only-test-token',
          sourceCommit: SOURCE_COMMIT,
          fetchImpl: (async () => {
            networkCalled = true;
            return new Response('unexpected');
          }) as typeof fetch,
          candidateSnapshotFile,
          sampleEvidenceFile,
        }),
      ).rejects.toThrow(/corpus sample evidence/);
      expect(networkCalled, testCase.name).toBe(false);
    }
  });

  it.each([
    {
      name: 'OID',
      mutate: (selected: Record<string, unknown>) => {
        selected.rootManifestOid = 'f'.repeat(40);
      },
    },
    {
      name: 'byte size',
      mutate: (selected: Record<string, unknown>) => {
        selected.rootManifestBytes = Number(selected.rootManifestBytes) + 1;
      },
    },
  ])('cross-checks the sample root manifest $name against the REST tree', async ({ mutate }) => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const candidateSnapshotFile = join(directory, 'repository-candidates.json');
    const sampleEvidenceFile = join(directory, 'repository-sample.json');
    const data = fixture();
    const provenance = completeProvenance(data);
    const selected = (provenance.sampleEvidence.selected as Array<Record<string, unknown>>)[0];
    if (selected === undefined) throw new Error('sample evidence test fixture was incomplete');
    mutate(selected);
    const observation: GitHubObservation = { rawUrls: [], rawAuthorization: [], rawRedirect: [] };
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);
    writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);
    writeFileSync(sampleEvidenceFile, `${JSON.stringify(provenance.sampleEvidence)}\n`, 'utf8');

    await expect(
      runCorpusScan({
        inputFile,
        outputDir,
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        fetchImpl: fakeGitHub(data.tree, data.blobs, observation),
        candidateSnapshotFile,
        sampleEvidenceFile,
      }),
    ).rejects.toThrow('one or more repositories failed');

    const persisted = JSON.parse(readFileSync(join(outputDir, 'corpus-run.json'), 'utf8')) as {
      repositories: Array<{ status: string; error?: string }>;
    };
    expect(persisted.repositories[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/root package\.json.*sample evidence/),
    });
    expect(observation.rawUrls).toEqual([]);
  });

  it('requires candidate and sample evidence files to be provided together', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const candidateSnapshotFile = join(directory, 'repository-candidates.json');
    const data = fixture();
    const provenance = completeProvenance(data);
    let networkCalled = false;
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);
    writeFileSync(candidateSnapshotFile, provenance.candidateSnapshot);

    await expect(
      runCorpusScan({
        inputFile,
        outputDir: join(directory, 'out'),
        token: 'read-only-test-token',
        sourceCommit: SOURCE_COMMIT,
        fetchImpl: (async () => {
          networkCalled = true;
          return new Response('unexpected');
        }) as typeof fetch,
        candidateSnapshotFile,
      }),
    ).rejects.toThrow(/candidate snapshot and sample evidence must be provided together/);
    expect(networkCalled).toBe(false);
  });
});
