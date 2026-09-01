import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const ROOTLESS_COMMIT = '1111111111111111111111111111111111111111';
const FIRST_ELIGIBLE_COMMIT = '2222222222222222222222222222222222222222';
const SECOND_ELIGIBLE_COMMIT = '3333333333333333333333333333333333333333';
const temporaryDirectories: string[] = [];

type Resolver = (options: {
  candidateFile: string;
  outputFile: string;
  evidenceFile: string;
  requested: number;
  token: string;
  fetchImpl: typeof fetch;
}) => Promise<unknown>;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-corpus-resolve-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function resolver(): Promise<Resolver> {
  const resolverUrl = pathToFileURL(join(process.cwd(), 'tools', 'corpus-resolve.ts')).href;
  const module = (await import(resolverUrl).catch(() => ({}))) as {
    resolveCorpusSample?: Resolver;
  };
  expect(typeof module.resolveCorpusSample).toBe('function');
  if (module.resolveCorpusSample === undefined) throw new Error('corpus resolver was unavailable');
  return module.resolveCorpusSample;
}

function candidateApi(): typeof fetch {
  const commits = new Map([
    ['alpha/rootless', ROOTLESS_COMMIT],
    ['beta/eligible', FIRST_ELIGIBLE_COMMIT],
    ['gamma/eligible', SECOND_ELIGIBLE_COMMIT],
  ]);

  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const repository = [...commits.keys()].find(
      (candidate) =>
        url.pathname === `/repos/${candidate}` || url.pathname.startsWith(`/repos/${candidate}/`),
    );
    if (repository === undefined) return new Response('missing repository', { status: 404 });

    if (url.pathname === `/repos/${repository}`) {
      return Response.json({ default_branch: 'main' });
    }
    if (url.pathname === `/repos/${repository}/commits`) {
      return Response.json([{ sha: commits.get(repository) }]);
    }
    if (url.pathname === `/repos/${repository}/git/trees/${commits.get(repository)}`) {
      const tree =
        repository === 'alpha/rootless'
          ? [
              {
                path: 'packages/child/package.json',
                mode: '100644',
                type: 'blob',
                sha: 'nested-manifest',
                size: 42,
                url: 'https://api.github.com/blob/nested-manifest',
              },
            ]
          : [
              {
                path: 'package.json',
                mode: '100644',
                type: 'blob',
                sha: `root-manifest-${repository}`,
                size: 42,
                url: `https://api.github.com/blob/root-manifest-${repository}`,
              },
            ];
      return Response.json({ sha: `tree-${repository}`, url: url.href, tree, truncated: false });
    }
    return new Response('missing route', { status: 404 });
  }) as typeof fetch;
}

it('replaces a rootless candidate before recording the exact requested sample', async () => {
  const directory = temporaryDirectory();
  const candidateFile = join(directory, 'candidates.txt');
  const outputFile = join(directory, 'repos.txt');
  const evidenceFile = join(directory, 'repository-sample.json');
  writeFileSync(
    candidateFile,
    'gamma/eligible\nalpha/rootless\nbeta/eligible\nalpha/rootless\n',
    'utf8',
  );

  await (await resolver())({
    candidateFile,
    outputFile,
    evidenceFile,
    requested: 2,
    token: 'read-only-test-token',
    fetchImpl: candidateApi(),
  });

  expect(readFileSync(outputFile, 'utf8')).toBe(
    `beta/eligible@${FIRST_ELIGIBLE_COMMIT}\ngamma/eligible@${SECOND_ELIGIBLE_COMMIT}\n`,
  );
  expect(JSON.parse(readFileSync(evidenceFile, 'utf8'))).toEqual({
    schemaVersion: 1,
    requested: 2,
    actual: 2,
    candidatesConsidered: 3,
    status: 'complete',
    exclusions: [
      {
        repository: 'alpha/rootless',
        commit: ROOTLESS_COMMIT,
        reason: 'root-package-json-unavailable',
      },
    ],
  });
});

it('hard-fails an API error and persists it instead of treating it as ineligibility', async () => {
  const directory = temporaryDirectory();
  const candidateFile = join(directory, 'candidates.txt');
  const outputFile = join(directory, 'repos.txt');
  const evidenceFile = join(directory, 'repository-sample.json');
  writeFileSync(candidateFile, 'alpha/project\n', 'utf8');

  await expect(
    (await resolver())({
      candidateFile,
      outputFile,
      evidenceFile,
      requested: 1,
      token: 'read-only-test-token',
      fetchImpl: (async () => new Response('rate limited', { status: 403 })) as typeof fetch,
    }),
  ).rejects.toThrow('GitHub API 403 for https://api.github.com/repos/alpha/project');

  expect(readFileSync(outputFile, 'utf8')).toBe('');
  expect(JSON.parse(readFileSync(evidenceFile, 'utf8'))).toEqual({
    schemaVersion: 1,
    requested: 1,
    actual: 0,
    candidatesConsidered: 1,
    status: 'failed',
    exclusions: [],
    error: 'GitHub API 403 for https://api.github.com/repos/alpha/project',
  });
});
