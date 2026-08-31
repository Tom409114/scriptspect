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

function fakeGitHub(tree: TreeEntry[], blobs: Record<string, Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/git/trees/')) {
      return Response.json({ tree, truncated: false });
    }
    const sha = url.split('/').at(-1) ?? '';
    const bytes = blobs[sha];
    if (bytes === undefined) return new Response('missing', { status: 404 });
    return Response.json({
      encoding: 'base64',
      content: bytes.toString('base64'),
      size: bytes.length,
    });
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
      { path: 'package.json', type: 'blob', mode: '100644', size: root.length, sha: 'root' },
      {
        path: 'packages/child/package.json',
        type: 'blob',
        mode: '100644',
        size: child.length,
        sha: 'child',
      },
      {
        path: 'node_modules/leak/package.json',
        type: 'blob',
        mode: '100644',
        size: 10,
        sha: 'excluded',
      },
    ],
    blobs: { root, child },
  };
}

describe('immutable corpus run evidence', () => {
  it('uses canonical workspace analysis while persisting hashes instead of script source', async () => {
    const directory = temporaryDirectory();
    const inputFile = join(directory, 'repos.txt');
    const outputDir = join(directory, 'out');
    const data = fixture();
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
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
    writeFileSync(inputFile, `example/project@${COMMIT}\n`);

    const manifest = await runCorpusScan({
      inputFile,
      outputDir,
      token: 'read-only-test-token',
      sourceCommit: SOURCE_COMMIT,
      generatedAt: '2026-09-01T00:00:00.000Z',
      fetchImpl: fakeGitHub(data.tree, data.blobs),
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
  });
});
