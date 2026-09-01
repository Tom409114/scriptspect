import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CORPUS_LIMITS, type TreeEntry } from '../../tools/corpus-lib';
import { runCorpusScan } from '../../tools/corpus-scan';

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
    const candidateSnapshot = Buffer.from('{"complete":true}\r\n', 'utf8');
    const candidateSnapshotSha256 = createHash('sha256').update(candidateSnapshot).digest('hex');
    const sampleEvidence = Buffer.from(
      `${JSON.stringify({
        status: 'complete',
        method: 'popularity-strata-round-robin-v1',
        candidateSnapshotSha256,
        selected: [{ repository: 'example/project', commit: COMMIT }],
      })}\n`,
      'utf8',
    );
    const data = fixture();
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

  it('rejects mismatched sample provenance before making a network request', async () => {
    const candidateSnapshot = Buffer.from('{"complete":true}\n', 'utf8');
    const candidateSnapshotSha256 = createHash('sha256').update(candidateSnapshot).digest('hex');
    const validEvidence = {
      status: 'complete',
      method: 'popularity-strata-round-robin-v1',
      candidateSnapshotSha256,
      selected: [{ repository: 'example/project', commit: COMMIT }],
    };
    const cases = [
      { name: 'status', evidence: { ...validEvidence, status: 'failed' } },
      { name: 'method', evidence: { ...validEvidence, method: 'wrong-method' } },
      {
        name: 'candidate snapshot digest',
        evidence: { ...validEvidence, candidateSnapshotSha256: '0'.repeat(64) },
      },
      {
        name: 'selected locator sequence',
        evidence: {
          ...validEvidence,
          selected: [{ repository: 'another/project', commit: COMMIT }],
        },
      },
    ];

    for (const testCase of cases) {
      const directory = temporaryDirectory();
      const inputFile = join(directory, 'repos.txt');
      const outputDir = join(directory, 'out');
      const candidateSnapshotFile = join(directory, 'repository-candidates.json');
      const sampleEvidenceFile = join(directory, 'repository-sample.json');
      const data = fixture();
      let networkCalled = false;
      writeFileSync(inputFile, `example/project@${COMMIT}\n`);
      writeFileSync(candidateSnapshotFile, candidateSnapshot);
      writeFileSync(sampleEvidenceFile, `${JSON.stringify(testCase.evidence)}\n`, 'utf8');
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
});
