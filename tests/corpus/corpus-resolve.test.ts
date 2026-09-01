import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const ROOTLESS_COMMIT = '1111111111111111111111111111111111111111';
const FIRST_ELIGIBLE_COMMIT = '2222222222222222222222222222222222222222';
const SECOND_ELIGIBLE_COMMIT = '3333333333333333333333333333333333333333';
const FIRST_BLOB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_BLOB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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

function candidateSnapshot(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      status: 'complete',
      method: 'popularity-strata-round-robin-v1',
      strata: [
        {
          id: 'typescript',
          query: 'language:typescript stars:>2000',
          sort: 'stars',
          order: 'desc',
          perPage: 100,
          responseSha256: 'a'.repeat(64),
          candidates: [
            { rank: 1, repository: 'alpha/rootless', stars: 300 },
            { rank: 2, repository: 'gamma/eligible', stars: 200 },
          ],
        },
        {
          id: 'javascript',
          query: 'language:javascript stars:>5000',
          sort: 'stars',
          order: 'desc',
          perPage: 100,
          responseSha256: 'b'.repeat(64),
          candidates: [
            { rank: 1, repository: 'beta/eligible', stars: 400 },
            { rank: 2, repository: 'alpha/rootless', stars: 300 },
          ],
        },
      ],
      orderedCandidates: [
        { position: 1, stratum: 'typescript', rank: 1, repository: 'alpha/rootless' },
        { position: 2, stratum: 'javascript', rank: 1, repository: 'beta/eligible' },
        { position: 3, stratum: 'typescript', rank: 2, repository: 'gamma/eligible' },
      ],
    },
    null,
    2,
  )}\n`;
}

function candidateApi(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.github.com/graphql');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as { query: string };
    expect(body.query).toContain('file(path: "package.json")');
    expect(body.query).toContain('rateLimit');
    return Response.json({
      data: {
        r0: {
          nameWithOwner: 'alpha/rootless',
          defaultBranchRef: {
            name: 'main',
            target: { __typename: 'Commit', oid: ROOTLESS_COMMIT, file: null },
          },
        },
        r1: {
          nameWithOwner: 'beta/eligible',
          defaultBranchRef: {
            name: 'main',
            target: {
              __typename: 'Commit',
              oid: FIRST_ELIGIBLE_COMMIT,
              file: {
                name: 'package.json',
                mode: 33188,
                type: 'blob',
                oid: FIRST_BLOB,
                object: { __typename: 'Blob', oid: FIRST_BLOB, byteSize: 42, isBinary: false },
              },
            },
          },
        },
        r2: {
          nameWithOwner: 'gamma/eligible',
          defaultBranchRef: {
            name: 'main',
            target: {
              __typename: 'Commit',
              oid: SECOND_ELIGIBLE_COMMIT,
              file: {
                name: 'package.json',
                mode: 33188,
                type: 'blob',
                oid: SECOND_BLOB,
                object: { __typename: 'Blob', oid: SECOND_BLOB, byteSize: 43, isBinary: false },
              },
            },
          },
        },
        rateLimit: {
          cost: 1,
          limit: 5000,
          remaining: 4999,
          used: 1,
          resetAt: '2026-09-01T01:00:00Z',
        },
      },
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['r0', 'defaultBranchRef', 'target', 'file'],
          message: "Could not resolve file for path 'package.json'.",
        },
      ],
    });
  }) as typeof fetch;
}

it('interleaves popularity strata, replaces rootless candidates, and hashes the full snapshot', async () => {
  const directory = temporaryDirectory();
  const candidateFile = join(directory, 'repository-candidates.json');
  const outputFile = join(directory, 'repos.txt');
  const evidenceFile = join(directory, 'repository-sample.json');
  const snapshotText = candidateSnapshot();
  writeFileSync(candidateFile, snapshotText, 'utf8');

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
    schemaVersion: 2,
    method: 'popularity-strata-round-robin-v1',
    candidateSnapshotSha256: createHash('sha256').update(snapshotText).digest('hex'),
    requested: 2,
    actual: 2,
    candidatesConsidered: 3,
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
        position: 2,
        stratum: 'javascript',
        rank: 1,
        repository: 'beta/eligible',
        commit: FIRST_ELIGIBLE_COMMIT,
        rootManifestOid: FIRST_BLOB,
        rootManifestBytes: 42,
      },
      {
        position: 3,
        stratum: 'typescript',
        rank: 2,
        repository: 'gamma/eligible',
        commit: SECOND_ELIGIBLE_COMMIT,
        rootManifestOid: SECOND_BLOB,
        rootManifestBytes: 43,
      },
    ],
    exclusions: [
      {
        position: 1,
        stratum: 'typescript',
        rank: 1,
        repository: 'alpha/rootless',
        commit: ROOTLESS_COMMIT,
        reason: 'root-package-json-unavailable',
      },
    ],
  });
});

it('hard-fails a rate exhaustion and persists non-secret response metadata', async () => {
  const directory = temporaryDirectory();
  const candidateFile = join(directory, 'repository-candidates.json');
  const outputFile = join(directory, 'repos.txt');
  const evidenceFile = join(directory, 'repository-sample.json');
  writeFileSync(candidateFile, candidateSnapshot(), 'utf8');
  const headers = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1788224400',
    'x-ratelimit-used': '5000',
    'x-ratelimit-resource': 'graphql',
    'retry-after': '60',
    'x-github-request-id': 'REQ-123',
  };

  await expect(
    (await resolver())({
      candidateFile,
      outputFile,
      evidenceFile,
      requested: 1,
      token: 'read-only-test-token-SHOULD-NOT-LEAK',
      fetchImpl: (async () =>
        new Response('{"message":"rate limited"}', { status: 403, headers })) as typeof fetch,
    }),
  ).rejects.toThrow('GitHub API 403 for https://api.github.com/graphql');

  expect(readFileSync(outputFile, 'utf8')).toBe('');
  const evidenceText = readFileSync(evidenceFile, 'utf8');
  expect(evidenceText).not.toContain('SHOULD-NOT-LEAK');
  expect(JSON.parse(evidenceText)).toMatchObject({
    schemaVersion: 2,
    status: 'failed',
    failure: {
      kind: 'primary-rate-limit-exhausted',
      status: 403,
      url: 'https://api.github.com/graphql',
      rateLimit: {
        limit: '5000',
        remaining: '0',
        reset: '1788224400',
        used: '5000',
        resource: 'graphql',
      },
      retryAfter: '60',
      requestId: 'REQ-123',
    },
  });
});

it('rejects a snapshot whose ordered universe does not reproduce its ranked strata', async () => {
  const directory = temporaryDirectory();
  const candidateFile = join(directory, 'repository-candidates.json');
  const snapshot = JSON.parse(candidateSnapshot()) as {
    orderedCandidates: Array<Record<string, unknown>>;
  };
  snapshot.orderedCandidates.reverse();
  writeFileSync(candidateFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
  let called = false;

  await expect(
    (await resolver())({
      candidateFile,
      outputFile: join(directory, 'repos.txt'),
      evidenceFile: join(directory, 'repository-sample.json'),
      requested: 1,
      token: 'read-only-test-token',
      fetchImpl: (async () => {
        called = true;
        return new Response('unexpected');
      }) as typeof fetch,
    }),
  ).rejects.toThrow('candidate snapshot ordering did not match its ranked strata');
  expect(called).toBe(false);
});
