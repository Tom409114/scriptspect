import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReleaseIntent } from '../../tools/release/release-state.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temporaryDirectories: string[] = [];

async function loadModule<T>(relativePath: string): Promise<T> {
  try {
    return (await import(new URL(relativePath, import.meta.url).href)) as T;
  } catch (error) {
    expect.fail(`release helper module ${relativePath} must load: ${String(error)}`);
  }
}

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `scriptspect-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);
const shaD = 'd'.repeat(64);
const commit = '1'.repeat(40);
const npmSRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const registryNpmSRI = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;

const intent = {
  schemaVersion: 'scriptspect-release-intent/v1',
  intentId: 'check-run:123456',
  prNumber: 62,
  mergeCommitSha: commit,
  version: '0.1.0',
  tag: 'v0.1.0',
  packageManifestHash: shaA,
  changelogHash: shaB,
  releasePleaseManifestHash: shaC,
  releasePrActor: 'googleapis-release-please[bot]',
  releasePrHead: 'googleapis:release-please--branches--main',
  releasePrHeadRepo: 'Tom409114/scriptspect',
  releasePrHeadSha: '2'.repeat(40),
} satisfies ReleaseIntent;

const retainedCandidate = {
  runId: 9001,
  artifactId: 8001,
  artifactDigest: shaD,
  candidateManifestDigest: shaA,
  npmSRI,
};

const stagedDraft = {
  releaseId: 7001,
  assets: [
    { name: 'scriptspect-0.1.0.tgz', assetId: 7101, sha256: shaB },
    { name: 'SHA256SUMS', assetId: 7102, sha256: shaC },
    { name: 'candidate-manifest.json', assetId: 7103, sha256: shaA },
  ],
  releaseManifestDigest: shaD,
};

type CanonicalTreeModule = {
  CANONICAL_TREE_ALGORITHM_DIGEST: string;
  CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST: string;
  canonicalizeTarball(path: string): {
    algorithm: string;
    algorithmDigest: string;
    treeDigest: string;
    entries: Array<{ path: string; type: string; mode: string; sha256: string | null }>;
  };
  canonicalizeTree(rootPath: string): Promise<{
    algorithm: string;
    algorithmDigest: string;
    treeDigest: string;
    entries: Array<{ path: string; type: string; mode: string; sha256: string | null }>;
  }>;
  compareCanonicalTrees(
    left: string,
    right: string,
  ): Promise<{
    equal: boolean;
    leftTreeDigest: string;
    rightTreeDigest: string;
    differences: Array<{ path: string; kind: string }>;
  }>;
  verifyCanonicalTreeBehaviorVectors(): {
    behaviorVectorDigest: string;
    verifiedVectors: string[];
  };
};

type ReleaseStateModule = {
  createReleaseState(input: unknown): unknown;
  transitionReleaseState(state: unknown, transition: unknown): unknown;
  validateReleaseIntent(input: unknown): unknown;
  validateReleaseAnchors(state: unknown, expected: unknown): unknown;
  validateCandidateManifest(input: unknown): unknown;
  validateReleaseManifest(release: unknown, candidate: unknown): unknown;
  canonicalJsonDigest(input: unknown): string;
  decideReleaseRecovery(input: unknown): unknown;
  verifyPublishAnchors(input: unknown): unknown;
  verifyFinalIdempotency(existing: unknown, proposed: unknown): unknown;
  selectExactCiRun(runs: unknown, expected: unknown): unknown;
  compareAndUpdateReleaseState(current: unknown, proposed: unknown): unknown;
  planFloatingAliases(input: unknown): unknown;
  decideAliasRollback(input: unknown): unknown;
};

type ProvenanceModule = {
  verifyProvenanceAudit(
    audit: unknown,
    expected: unknown,
  ): {
    package: string;
    version: string;
    predicateType: string;
    statementDigest: string;
  };
};

type TarFixtureEntry = {
  name: string;
  type?: '0' | '2' | '5' | 'x';
  mode?: number;
  data?: string | Buffer;
  linkName?: string;
};

function tarField(value: string, width: number): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > width) throw new Error(`fixture tar field exceeds ${width} bytes`);
  const field = Buffer.alloc(width);
  encoded.copy(field);
  return field;
}

function tarOctal(value: number, width: number): Buffer {
  return tarField(`${value.toString(8).padStart(width - 1, '0')}\0`, width);
}

function tarFixtureHeader(entry: TarFixtureEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  tarField(entry.name, 100).copy(header, 0);
  tarOctal(entry.mode ?? 0o644, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(size, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? '0').charCodeAt(0);
  tarField(entry.linkName ?? '', 100).copy(header, 157);
  tarField('ustar\0', 6).copy(header, 257);
  tarField('00', 2).copy(header, 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  tarField(`${checksum.toString(8).padStart(6, '0')}\0 `, 8).copy(header, 148);
  return header;
}

function rawTarFixture(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    chunks.push(tarFixtureHeader(entry, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeTarFixture(name: string, archive: Buffer): string {
  const directory = temporaryDirectory(name);
  const tarball = join(directory, 'fixture.tgz');
  writeFileSync(tarball, gzipSync(archive));
  return tarball;
}

function paxFixtureData(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const body = `${key}=${value}\n`;
      let length = Buffer.byteLength(body, 'utf8') + 2;
      while (Buffer.byteLength(`${length} ${body}`, 'utf8') !== length) {
        length = Buffer.byteLength(`${length} ${body}`, 'utf8');
      }
      return `${length} ${body}`;
    })
    .join('');
}

function fixtureStableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fixtureStableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${fixtureStableJson(child)}`)
    .join(',')}}`;
}

function fixtureDigest(value: unknown): string {
  return createHash('sha256').update(fixtureStableJson(value), 'utf8').digest('hex');
}

function fixtureTreeDigest(
  entries: Array<{ path: string; type: string; mode: string; sha256: string | null }>,
): string {
  const records = entries
    .map((entry) => `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.sha256 ?? ''}\n`)
    .join('');
  return createHash('sha256').update(records, 'utf8').digest('hex');
}

const paxTarget = '../pax-target';
const symlinkTarget = '../bin/tool.mjs';
const vectorPaxEntries = [
  { path: 'package', type: 'directory', mode: '0755', sha256: null },
  {
    path: 'package/pax-link',
    type: 'symlink',
    mode: '0777',
    sha256: createHash('sha256').update(paxTarget, 'utf8').digest('hex'),
  },
];
const vectorModeEntries = [
  {
    path: 'mode.sh',
    type: 'file',
    mode: '4755',
    sha256: createHash('sha256').update('mode\n', 'utf8').digest('hex'),
  },
];
const vectorSymlinkEntries = [
  {
    path: 'tool-link',
    type: 'symlink',
    mode: '0777',
    sha256: createHash('sha256').update(symlinkTarget, 'utf8').digest('hex'),
  },
];
const expectedBehaviorVectorContract = {
  schemaVersion: 'scriptspect-canonical-tree-behaviors/v1',
  vectors: [
    {
      name: 'pax-path-and-linkpath',
      input: {
        entries: [
          { type: 'pax', fields: { path: 'package/pax-link', linkpath: paxTarget } },
          {
            type: 'symlink',
            path: 'ignored-link',
            mode: '0777',
            linkTarget: 'ignored-target',
          },
        ],
      },
      expected: {
        entries: vectorPaxEntries,
        treeDigest: fixtureTreeDigest(vectorPaxEntries),
      },
    },
    {
      name: 'duplicate-path',
      input: {
        entries: [
          { type: 'file', path: 'duplicate.txt', mode: '0644', content: 'one\n' },
          { type: 'file', path: 'duplicate.txt', mode: '0644', content: 'two\n' },
        ],
      },
      expected: { error: 'tar archive contains duplicate entry duplicate.txt' },
    },
    {
      name: 'mode-high-bits-mask',
      input: {
        entries: [{ type: 'file', path: 'mode.sh', mode: '104755', content: 'mode\n' }],
      },
      expected: {
        entries: vectorModeEntries,
        treeDigest: fixtureTreeDigest(vectorModeEntries),
      },
    },
    {
      name: 'symlink-target-digest',
      input: {
        entries: [{ type: 'symlink', path: 'tool-link', mode: '0777', linkTarget: symlinkTarget }],
      },
      expected: {
        entries: vectorSymlinkEntries,
        treeDigest: fixtureTreeDigest(vectorSymlinkEntries),
      },
    },
    {
      name: 'truncated-archive',
      input: {
        entries: [{ type: 'file', path: 'truncated.txt', mode: '0644', content: 'x' }],
        truncateBytes: 1,
      },
      expected: { error: 'tar archive length is not a multiple of 512 bytes' },
    },
  ],
};
const expectedBehaviorVectorDigest = fixtureDigest(expectedBehaviorVectorContract);
const expectedAlgorithmDigest = fixtureDigest({
  archive:
    'gzip tar with verified headers and safe paths; regular files, directories, and symlinks; implicit directories mode 0755',
  behaviorVectorDigest: expectedBehaviorVectorDigest,
  contentDigest: 'sha256 raw file bytes; sha256 utf8 link target; null for directory',
  entryOrder: 'relative POSIX path ascending by UTF-8 code unit',
  entryRecord: 'path NUL type NUL mode-octal NUL content-digest-or-empty LF',
  mode: 'lstat mode & 0o7777 encoded as four lowercase octal digits',
  root: 'realpath directory; root entry excluded',
  version: 'scriptspect-canonical-tree/v1',
});

describe('versioned canonical tree comparison', () => {
  it('binds the public algorithm digest to executable immutable behavior vectors', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');

    expect(expectedBehaviorVectorDigest).toBe(
      'd5a50eff68ef6d9efc4f0bf58c8e2a4c4dd9df869b67ac277dc53c8adc33c1bc',
    );
    expect(expectedAlgorithmDigest).toBe(
      'e4134401ced1d74c8f082a6a7950ef074d5a0ec9c24d6c1531a25254c9661ea3',
    );
    expect(tools.CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST).toBe(expectedBehaviorVectorDigest);
    expect(tools.CANONICAL_TREE_ALGORITHM_DIGEST).toBe(expectedAlgorithmDigest);
    expect(tools.verifyCanonicalTreeBehaviorVectors()).toEqual({
      behaviorVectorDigest: expectedBehaviorVectorDigest,
      verifiedVectors: expectedBehaviorVectorContract.vectors.map((vector) => vector.name),
    });
  });

  it('applies local PAX path and linkpath once', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const tarball = writeTarFixture(
      'tree-pax',
      rawTarFixture([
        {
          name: 'PaxHeaders/link',
          type: 'x',
          mode: 0,
          data: paxFixtureData({ path: 'package/pax-link', linkpath: paxTarget }),
        },
        {
          name: 'ignored-link',
          type: '2',
          mode: 0o777,
          linkName: 'ignored-target',
        },
        { name: 'plain.txt', mode: 0o644, data: 'plain\n' },
      ]),
    );

    const manifest = tools.canonicalizeTarball(tarball);

    expect(manifest.entries).toEqual([
      { path: 'package', type: 'directory', mode: '0755', sha256: null },
      {
        path: 'package/pax-link',
        type: 'symlink',
        mode: '0777',
        sha256: createHash('sha256').update(paxTarget, 'utf8').digest('hex'),
      },
      {
        path: 'plain.txt',
        type: 'file',
        mode: '0644',
        sha256: createHash('sha256').update('plain\n', 'utf8').digest('hex'),
      },
    ]);
  });

  it('rejects duplicate normalized tar paths', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const tarball = writeTarFixture(
      'tree-duplicate',
      rawTarFixture([
        { name: './duplicate.txt', mode: 0o644, data: 'one\n' },
        { name: 'duplicate.txt', mode: 0o644, data: 'two\n' },
      ]),
    );

    expect(() => tools.canonicalizeTarball(tarball)).toThrow(
      'tar archive contains duplicate entry duplicate.txt',
    );
  });

  it('normalizes mode high bits and preserves executable and special bits', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const tarball = writeTarFixture(
      'tree-mode',
      rawTarFixture([
        { name: 'package/', type: '5', mode: 0o102750 },
        { name: 'package/tool.sh', mode: 0o104755, data: 'mode\n' },
      ]),
    );

    expect(tools.canonicalizeTarball(tarball).entries).toEqual([
      { path: 'package', type: 'directory', mode: '2750', sha256: null },
      {
        path: 'package/tool.sh',
        type: 'file',
        mode: '4755',
        sha256: createHash('sha256').update('mode\n', 'utf8').digest('hex'),
      },
    ]);
  });

  it('hashes a symlink target without following it', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const tarball = writeTarFixture(
      'tree-symlink',
      rawTarFixture([{ name: 'tool-link', type: '2', mode: 0o777, linkName: symlinkTarget }]),
    );

    expect(tools.canonicalizeTarball(tarball).entries).toEqual([
      {
        path: 'tool-link',
        type: 'symlink',
        mode: '0777',
        sha256: createHash('sha256').update(symlinkTarget, 'utf8').digest('hex'),
      },
    ]);
  });

  it('rejects a tar archive truncated after an otherwise valid entry', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const complete = rawTarFixture([{ name: 'truncated.txt', data: 'x' }]);
    const tarball = writeTarFixture('tree-truncated', complete.subarray(0, complete.length - 1));

    expect(() => tools.canonicalizeTarball(tarball)).toThrow(
      'tar archive length is not a multiple of 512 bytes',
    );
  });

  it('refuses to report the algorithm digest when the parser drifts from its vectors', () => {
    const directory = temporaryDirectory('tree-parser-drift');
    const releaseDirectory = join(directory, 'release');
    mkdirSync(releaseDirectory);
    const sourcePath = join(root, 'tools', 'release', 'canonical-tree.mjs');
    const source = readFileSync(sourcePath, 'utf8');
    const drifted = source.replace("typeFlag === '2'", "typeFlag === '9'");
    expect(drifted).not.toBe(source);
    writeFileSync(join(releaseDirectory, 'canonical-tree.mjs'), drifted);
    writeFileSync(
      join(releaseDirectory, 'shared.mjs'),
      readFileSync(join(root, 'tools', 'release', 'shared.mjs')),
    );

    let failure: unknown;
    try {
      execFileSync(
        process.execPath,
        [join(releaseDirectory, 'canonical-tree.mjs'), 'algorithm-digest'],
        {
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    const stderr = (failure as { stderr?: string | Buffer }).stderr;
    expect(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr).toMatch(
      /behavior vector.*pax-path-and-linkpath/i,
    );
  });

  it('produces a stable complete tree independent of creation order', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const left = temporaryDirectory('tree-left');
    const right = temporaryDirectory('tree-right');
    mkdirSync(join(left, 'lib'));
    writeFileSync(join(left, 'z.txt'), 'z\n');
    writeFileSync(join(left, 'lib', 'a.txt'), 'a\n');
    writeFileSync(join(left, '\uE000.txt'), 'bmp\n');
    writeFileSync(join(left, '\u{10000}.txt'), 'supplementary\n');
    writeFileSync(join(right, 'z.txt'), 'z\n');
    mkdirSync(join(right, 'lib'));
    writeFileSync(join(right, 'lib', 'a.txt'), 'a\n');
    writeFileSync(join(right, '\uE000.txt'), 'bmp\n');
    writeFileSync(join(right, '\u{10000}.txt'), 'supplementary\n');

    const leftTree = await tools.canonicalizeTree(left);
    const rightTree = await tools.canonicalizeTree(right);

    expect(leftTree.algorithm).toBe('scriptspect-canonical-tree/v1');
    expect(leftTree.algorithmDigest).toBe(
      'e4134401ced1d74c8f082a6a7950ef074d5a0ec9c24d6c1531a25254c9661ea3',
    );
    expect(tools.CANONICAL_TREE_ALGORITHM_DIGEST).toBe(leftTree.algorithmDigest);
    expect(leftTree.entries.map((entry) => entry.path)).toEqual([
      'lib',
      'lib/a.txt',
      'z.txt',
      '\uE000.txt',
      '\u{10000}.txt',
    ]);
    expect(leftTree).toEqual(rightTree);
    await expect(tools.compareCanonicalTrees(left, right)).resolves.toMatchObject({
      equal: true,
      differences: [],
    });
  });

  it('reports a content mismatch without silently excluding package.json', async () => {
    const tools = await loadModule<CanonicalTreeModule>('../../tools/release/canonical-tree.mjs');
    const left = temporaryDirectory('tree-content-left');
    const right = temporaryDirectory('tree-content-right');
    writeFileSync(join(left, 'package.json'), '{"version":"0.1.0"}\n');
    writeFileSync(join(right, 'package.json'), '{"version":"9.9.9"}\n');

    const comparison = await tools.compareCanonicalTrees(left, right);

    expect(comparison.equal).toBe(false);
    expect(comparison.leftTreeDigest).not.toBe(comparison.rightTreeDigest);
    expect(comparison.differences).toEqual([{ path: 'package.json', kind: 'content' }]);
  });

  it('runs as a JSON-only Node CLI', () => {
    const directory = temporaryDirectory('tree-cli');
    writeFileSync(join(directory, 'index.js'), 'export {};\n');

    const stdout = execFileSync(
      process.execPath,
      [join(root, 'tools', 'release', 'canonical-tree.mjs'), directory],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      algorithm: 'scriptspect-canonical-tree/v1',
      entries: [{ path: 'index.js', type: 'file' }],
    });
  });

  it('exposes the algorithm digest and digests a real gzip tar archive', () => {
    const directory = temporaryDirectory('tree-tarball');
    const packageDirectory = join(directory, 'package');
    const tarball = join(directory, 'package.tgz');
    mkdirSync(packageDirectory);
    writeFileSync(join(packageDirectory, 'package.json'), '{"name":"fixture"}\n');
    execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
    const cli = join(root, 'tools', 'release', 'canonical-tree.mjs');

    const algorithm = JSON.parse(
      execFileSync(process.execPath, [cli, 'algorithm-digest'], { encoding: 'utf8' }),
    );
    const manifest = JSON.parse(
      execFileSync(process.execPath, [cli, 'digest', '--tarball', tarball], {
        encoding: 'utf8',
      }),
    );

    expect(algorithm).toEqual({
      algorithm: 'scriptspect-canonical-tree/v1',
      algorithmDigest: 'e4134401ced1d74c8f082a6a7950ef074d5a0ec9c24d6c1531a25254c9661ea3',
    });
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package/package.json', type: 'file' }),
      ]),
    );
  });
});

describe('durable release state and anchors', () => {
  it('validates the exact release intent and rejects an unknown or inconsistent field', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');

    expect(tools.validateReleaseIntent(intent)).toEqual(intent);
    expect(() => tools.validateReleaseIntent({ ...intent, tag: 'v0.2.0' })).toThrow(
      /tag.*version/i,
    );
    expect(() =>
      tools.validateReleaseIntent({ ...intent, releasePrHeadRepo: 'attacker/fork' }),
    ).toThrow(/head repo/i);
    expect(() => tools.validateReleaseIntent({ ...intent, injected: true })).toThrow(
      /unknown.*injected/i,
    );
    expect(() =>
      tools.validateReleaseIntent({ ...intent, version: '0.1.0-01', tag: 'v0.1.0-01' }),
    ).toThrow(/version.*invalid format/i);
  });

  it('permits only sequential transitions and exact idempotent repeats', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const initial = tools.createReleaseState(intent);
    expect(initial).toMatchObject({ state: 'intent-recorded' });
    const retained = tools.transitionReleaseState(initial, {
      to: 'retained-candidate',
      payload: retainedCandidate,
    });
    const staged = tools.transitionReleaseState(retained, {
      to: 'staged-draft',
      payload: stagedDraft,
    });
    const npmPublished = tools.transitionReleaseState(staged, {
      to: 'npm-published',
      payload: { publishedVersion: '0.1.0', npmSRI, publishRunId: 9001 },
    });
    const npmVerified = tools.transitionReleaseState(npmPublished, {
      to: 'npm-verified',
      payload: {
        registryNpmSRI,
        registryManifestDigest: shaA,
        provenanceDigest: shaB,
      },
    });
    const aliasesVerified = tools.transitionReleaseState(npmVerified, {
      to: 'aliases-verified',
      payload: {
        aliases: [
          { name: 'v0.1', previousTarget: null, target: commit },
          { name: 'v0', previousTarget: '2'.repeat(40), target: commit },
        ],
      },
    });
    const consumed = tools.transitionReleaseState(aliasesVerified, {
      to: 'consumed',
      payload: { finalVerificationDigest: shaC },
    });

    expect(consumed).toMatchObject({
      schemaVersion: 'scriptspect-release-state/v1',
      state: 'consumed',
      intent,
      retainedCandidate,
      stagedDraft,
      npmVerified: { registryNpmSRI, registryManifestDigest: shaA, provenanceDigest: shaB },
      consumed: { finalVerificationDigest: shaC },
    });
    expect(
      tools.transitionReleaseState(consumed, {
        to: 'staged-draft',
        payload: stagedDraft,
      }),
    ).toEqual(consumed);
    expect(() =>
      tools.transitionReleaseState(initial, {
        to: 'staged-draft',
        payload: stagedDraft,
      }),
    ).toThrow(/invalid transition/i);
    expect(() =>
      tools.transitionReleaseState(consumed, {
        to: 'staged-draft',
        payload: { ...stagedDraft, releaseId: 9999 },
      }),
    ).toThrow(/conflict/i);
  });

  it('checks every requested anchor against the durable state', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const retained = tools.transitionReleaseState(tools.createReleaseState(intent), {
      to: 'retained-candidate',
      payload: retainedCandidate,
    });
    const staged = tools.transitionReleaseState(retained, {
      to: 'staged-draft',
      payload: stagedDraft,
    });

    expect(
      tools.validateReleaseAnchors(staged, {
        intentId: intent.intentId,
        mergeCommitSha: commit,
        version: '0.1.0',
        tag: 'v0.1.0',
        artifactDigest: shaD,
        candidateManifestDigest: shaA,
        releaseId: 7001,
        releaseManifestDigest: shaD,
        assets: stagedDraft.assets,
      }),
    ).toMatchObject({ state: 'staged-draft' });
    expect(() =>
      tools.validateReleaseAnchors(staged, {
        intentId: intent.intentId,
        mergeCommitSha: '2'.repeat(40),
      }),
    ).toThrow(/mergeCommitSha.*conflict/i);
  });

  it('rejects stale state writers and permits only the exact next revision', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const initial = tools.createReleaseState(intent) as Record<string, unknown>;
    const retained = tools.transitionReleaseState(initial, {
      to: 'retained-candidate',
      payload: retainedCandidate,
    }) as Record<string, unknown>;
    const staged = tools.transitionReleaseState(retained, {
      to: 'staged-draft',
      payload: stagedDraft,
    });

    expect(initial.revision).toBe(0);
    expect(retained.revision).toBe(1);
    expect(tools.compareAndUpdateReleaseState(initial, retained)).toEqual(retained);
    expect(() => tools.compareAndUpdateReleaseState(staged, retained)).toThrow(/stale.*revision/i);
    expect(() =>
      tools.compareAndUpdateReleaseState(retained, {
        ...retained,
        revision: 2,
        state: 'intent-recorded',
      }),
    ).toThrow(/state.*regression/i);
    expect(tools.compareAndUpdateReleaseState(staged, staged)).toEqual(staged);
  });
});

describe('monotonic floating aliases', () => {
  it('maps aliases dynamically and rejects an older version retry', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');

    expect(
      tools.planFloatingAliases({
        version: '0.2.0',
        commit,
        current: [
          { name: 'v0.2', target: null, version: null, ancestor: null },
          { name: 'v0', target: '2'.repeat(40), version: '0.1.9', ancestor: true },
        ],
      }),
    ).toMatchObject({ aliases: [{ name: 'v0.2' }, { name: 'v0' }] });

    expect(() =>
      tools.planFloatingAliases({
        version: '0.1.8',
        commit,
        current: [
          { name: 'v0.1', target: '3'.repeat(40), version: '0.1.9', ancestor: false },
          { name: 'v0', target: '3'.repeat(40), version: '0.1.9', ancestor: false },
        ],
      }),
    ).toThrow(/semver.*downgrade/i);
  });

  it('fails closed on unrelated ancestry and defines crash-safe partial rollback', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const candidate = commit;
    const previous = '2'.repeat(40);

    expect(() =>
      tools.planFloatingAliases({
        version: '0.2.0',
        commit: candidate,
        current: [
          { name: 'v0.2', target: previous, version: '0.1.9', ancestor: false },
          { name: 'v0', target: previous, version: '0.1.9', ancestor: false },
        ],
      }),
    ).toThrow(/ancestry/i);
    expect(tools.decideAliasRollback({ current: candidate, candidate, previous })).toEqual({
      action: 'restore',
      target: previous,
    });
    expect(tools.decideAliasRollback({ current: candidate, candidate, previous: null })).toEqual({
      action: 'retain',
      target: candidate,
    });
    expect(() =>
      tools.decideAliasRollback({ current: '3'.repeat(40), candidate, previous }),
    ).toThrow(/CAS conflict/i);
  });
});

describe('candidate, draft, recovery, and final verification', () => {
  function candidateManifest() {
    return {
      schemaVersion: 'scriptspect-candidate-manifest/v1',
      intent,
      version: '0.1.0',
      tag: 'v0.1.0',
      commit,
      tarball: { name: 'scriptspect-0.1.0.tgz', sha256: shaB, npmSRI },
      build: { node: 'v24.14.1', npm: '11.17.0', pnpm: '11.24.0' },
      workflow: {
        runId: 9001,
        runAttempt: 1,
        runUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/9001',
      },
    };
  }

  function releaseManifest(candidateDigest: string) {
    return {
      schemaVersion: 'scriptspect-release-manifest/v1',
      intentId: intent.intentId,
      version: '0.1.0',
      tag: 'v0.1.0',
      commit,
      releaseId: 7001,
      candidateManifestDigest: candidateDigest,
      assets: [
        { name: 'scriptspect-0.1.0.tgz', assetId: 7101, sha256: shaB },
        { name: 'SHA256SUMS', assetId: 7102, sha256: shaC },
        { name: 'candidate-manifest.json', assetId: 7103, sha256: candidateDigest },
      ],
    };
  }

  it('validates strict cross-linked candidate and release manifests', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const candidate = candidateManifest();
    const candidateDigest = tools.canonicalJsonDigest(candidate);
    const release = releaseManifest(candidateDigest);

    expect(tools.validateCandidateManifest(candidate)).toEqual(candidate);
    expect(tools.validateReleaseManifest(release, candidate)).toEqual(release);
    expect(() => tools.validateCandidateManifest({ ...candidate, releaseId: 7001 })).toThrow(
      /unknown.*releaseId/i,
    );
    expect(() =>
      tools.validateReleaseManifest({ ...release, candidateManifestDigest: shaD }, candidate),
    ).toThrow(/candidateManifestDigest.*conflict/i);
  });

  it('decides deterministic recovery for tag-only, partial draft, conflict, and loss', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const expected = {
      tag: 'v0.1.0',
      commit,
      retainedArtifactDigest: shaD,
      candidateManifestDigest: shaA,
      assets: stagedDraft.assets,
    };
    const retained = { artifactDigest: shaD, candidateManifestDigest: shaA };

    expect(
      tools.decideReleaseRecovery({
        expected,
        observed: { tag: { commit }, draft: null, retainedCandidate: retained },
      }),
    ).toEqual({ action: 'create-draft', reason: 'exact-tag-without-draft' });
    expect(
      tools.decideReleaseRecovery({
        expected,
        observed: {
          tag: { commit },
          draft: {
            releaseId: 7001,
            tag: 'v0.1.0',
            commit,
            assets: stagedDraft.assets.slice(1),
          },
          retainedCandidate: retained,
        },
      }),
    ).toEqual({
      action: 'restore-assets',
      reason: 'verified-retained-candidate',
      missingAssets: ['scriptspect-0.1.0.tgz'],
    });
    expect(
      tools.decideReleaseRecovery({
        expected,
        observed: {
          tag: { commit: '2'.repeat(40) },
          draft: null,
          retainedCandidate: retained,
        },
      }),
    ).toEqual({ action: 'manual-recovery', reason: 'tag-commit-conflict' });
    expect(
      tools.decideReleaseRecovery({
        expected,
        observed: {
          tag: { commit },
          draft: { releaseId: 7001, tag: 'v0.1.0', commit, assets: [] },
          retainedCandidate: null,
        },
      }),
    ).toEqual({ action: 'new-version-required', reason: 'authoritative-artifact-lost' });
  });

  it('decides partial-draft recovery before GitHub asset IDs are known', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const expectedAssets = stagedDraft.assets.map(({ name, sha256 }) => ({ name, sha256 }));

    expect(
      tools.decideReleaseRecovery({
        expected: {
          tag: 'v0.1.0',
          commit,
          retainedArtifactDigest: shaD,
          candidateManifestDigest: shaA,
          assets: expectedAssets,
        },
        observed: {
          tag: { commit },
          draft: {
            releaseId: 7001,
            tag: 'v0.1.0',
            commit,
            assets: [stagedDraft.assets[1]],
          },
          retainedCandidate: { artifactDigest: shaD, candidateManifestDigest: shaA },
        },
      }),
    ).toEqual({
      action: 'restore-assets',
      reason: 'verified-retained-candidate',
      missingAssets: ['scriptspect-0.1.0.tgz', 'candidate-manifest.json'],
    });
  });

  it('verifies all publish anchors before returning the authoritative asset', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const candidate = candidateManifest();
    const candidateDigest = tools.canonicalJsonDigest(candidate);
    const release = releaseManifest(candidateDigest);
    const retained = tools.transitionReleaseState(tools.createReleaseState(intent), {
      to: 'retained-candidate',
      payload: { ...retainedCandidate, candidateManifestDigest: candidateDigest },
    });
    const state = tools.transitionReleaseState(retained, {
      to: 'staged-draft',
      payload: {
        releaseId: 7001,
        assets: release.assets,
        releaseManifestDigest: tools.canonicalJsonDigest(release),
      },
    });
    const observed = {
      tag: { name: 'v0.1.0', commit },
      release: { releaseId: 7001, tag: 'v0.1.0', commit, draft: true },
      assets: release.assets,
    };

    expect(tools.verifyPublishAnchors({ state, candidate, release, observed })).toEqual({
      releaseId: 7001,
      assetId: 7101,
      assetName: 'scriptspect-0.1.0.tgz',
      sha256: shaB,
      npmSRI,
    });
    expect(() =>
      tools.verifyPublishAnchors({
        state,
        candidate,
        release,
        observed: { ...observed, tag: { name: 'v0.1.0', commit: '2'.repeat(40) } },
      }),
    ).toThrow(/tag.*conflict/i);
    expect(() =>
      tools.verifyPublishAnchors({
        state,
        candidate,
        release,
        observed: {
          ...observed,
          release: { ...observed.release, draft: false },
        },
      }),
    ).toThrow(/release.*conflict/i);

    const published = tools.transitionReleaseState(state, {
      to: 'npm-published',
      payload: { publishedVersion: '0.1.0', npmSRI, publishRunId: 9001 },
    });
    const verified = tools.transitionReleaseState(published, {
      to: 'npm-verified',
      payload: { registryNpmSRI, registryManifestDigest: shaA, provenanceDigest: shaB },
    });
    expect(
      tools.verifyPublishAnchors({
        state: verified,
        candidate,
        release,
        observed: {
          ...observed,
          release: { ...observed.release, draft: false },
        },
      }),
    ).toMatchObject({ releaseId: 7001, assetId: 7101 });

    const reorderedState = tools.transitionReleaseState(retained, {
      to: 'staged-draft',
      payload: {
        releaseId: 7001,
        assets: [...release.assets].reverse(),
        releaseManifestDigest: tools.canonicalJsonDigest(release),
      },
    });
    expect(
      tools.verifyPublishAnchors({
        state: reorderedState,
        candidate,
        release,
        observed: { ...observed, assets: [...release.assets].reverse() },
      }),
    ).toMatchObject({ releaseId: 7001, assetId: 7101 });
  });

  it('writes final verification once and reuses only an exact repeat', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const verification = {
      schemaVersion: 'scriptspect-final-verification/v1',
      intentId: intent.intentId,
      version: '0.1.0',
      tag: 'v0.1.0',
      commit,
      releaseId: 7001,
      candidateManifestDigest: shaA,
      releaseManifestDigest: shaD,
      candidateNpmSRI: npmSRI,
      registryNpmSRI,
      provenanceDigest: shaB,
      aliases: [
        { name: 'v0.1', target: commit },
        { name: 'v0', target: commit },
      ],
    };

    expect(tools.verifyFinalIdempotency(null, verification)).toEqual({
      decision: 'write',
      verification,
    });
    expect(tools.verifyFinalIdempotency(verification, { ...verification })).toEqual({
      decision: 'reuse',
      verification,
    });
    expect(() =>
      tools.verifyFinalIdempotency(verification, {
        ...verification,
        releaseId: 9999,
      }),
    ).toThrow(/final verification conflict/i);
  });

  it('persists transition output atomically through the JSON CLI', async () => {
    const directory = temporaryDirectory('state-cli');
    const intentPath = join(directory, 'intent.json');
    const statePath = join(directory, 'state.json');
    const transitionPath = join(directory, 'transition.json');
    writeFileSync(intentPath, `${JSON.stringify(intent)}\n`);
    writeFileSync(
      transitionPath,
      `${JSON.stringify({ to: 'retained-candidate', payload: retainedCandidate })}\n`,
    );
    const cli = join(root, 'tools', 'release', 'release-state.mjs');

    execFileSync(process.execPath, [cli, 'create-state', intentPath, '--out', statePath]);
    execFileSync(process.execPath, [
      cli,
      'transition',
      statePath,
      transitionPath,
      '--out',
      statePath,
    ]);

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      state: 'retained-candidate',
      retainedCandidate,
    });
  });

  it('accepts the one-file final-idempotency CLI input used by the coordinator', () => {
    const directory = temporaryDirectory('final-cli');
    const inputPath = join(directory, 'final-input.json');
    const verification = {
      schemaVersion: 'scriptspect-final-verification/v1',
      intentId: intent.intentId,
      version: '0.1.0',
      tag: 'v0.1.0',
      commit,
      releaseId: 7001,
      candidateManifestDigest: shaA,
      releaseManifestDigest: shaD,
      candidateNpmSRI: npmSRI,
      registryNpmSRI,
      provenanceDigest: shaB,
      aliases: [
        { name: 'v0.1', target: commit },
        { name: 'v0', target: commit },
      ],
    };
    writeFileSync(inputPath, `${JSON.stringify({ existing: null, proposed: verification })}\n`);

    const stdout = execFileSync(
      process.execPath,
      [join(root, 'tools', 'release', 'release-state.mjs'), 'final-idempotency', inputPath],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(stdout)).toMatchObject({ decision: 'write', verification });
  });

  it('computes the canonical JSON digest used by every manifest anchor', () => {
    const directory = temporaryDirectory('json-digest-cli');
    const compactPath = join(directory, 'compact.json');
    const prettyPath = join(directory, 'pretty.json');
    writeFileSync(compactPath, '{"z":1,"a":{"b":2}}\n');
    writeFileSync(prettyPath, '{\n  "a": { "b": 2 },\n  "z": 1\n}\n');
    const cli = join(root, 'tools', 'release', 'release-state.mjs');

    const compact = JSON.parse(
      execFileSync(process.execPath, [cli, 'json-digest', compactPath], { encoding: 'utf8' }),
    );
    const pretty = JSON.parse(
      execFileSync(process.execPath, [cli, 'json-digest', prettyPath], { encoding: 'utf8' }),
    );

    expect(compact).toEqual(pretty);
    expect(compact).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('writes canonical JSON bytes whose raw SHA-256 equals json-digest', () => {
    const directory = temporaryDirectory('canonical-json-cli');
    const inputPath = join(directory, 'pretty.json');
    const outputPath = join(directory, 'canonical.json');
    writeFileSync(inputPath, '{\n  "z": 1,\n  "a": { "b": 2 }\n}\n');
    const cli = join(root, 'tools', 'release', 'release-state.mjs');

    execFileSync(process.execPath, [cli, 'canonicalize-json', inputPath, '--out', outputPath], {
      encoding: 'utf8',
    });
    const bytes = readFileSync(outputPath);
    const digest = JSON.parse(
      execFileSync(process.execPath, [cli, 'json-digest', outputPath], { encoding: 'utf8' }),
    );

    expect(bytes.toString('utf8')).toBe('{"a":{"b":2},"z":1}\n');
    expect(digest).toEqual({ digest: createHash('sha256').update(bytes).digest('hex') });
  });
});

describe('exact CI gate selection', () => {
  it('selects only the unique successful run with every trust anchor exact', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const exact = {
      id: 4001,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      head_sha: commit,
      event: 'push',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      head_repository: { full_name: 'Tom409114/scriptspect' },
      run_number: 73,
      run_attempt: 1,
      html_url: 'https://github.com/Tom409114/scriptspect/actions/runs/4001',
    };
    const runs = {
      workflow_runs: [
        { ...exact, id: 3999, conclusion: 'failure' },
        { ...exact, id: 4000, head_sha: '2'.repeat(40) },
        exact,
      ],
    };
    const expected = {
      sha: commit,
      workflowName: 'CI',
      workflowPath: '.github/workflows/ci.yml',
      event: 'push',
      branch: 'main',
      repository: 'Tom409114/scriptspect',
      selection: 'unique',
    };

    expect(tools.selectExactCiRun(runs, expected)).toEqual({
      id: 4001,
      runNumber: 73,
      runAttempt: 1,
      url: exact.html_url,
      sha: commit,
    });
    expect(() =>
      tools.selectExactCiRun({ workflow_runs: [exact, { ...exact, id: 4002 }] }, expected),
    ).toThrow(/ambiguous.*2/i);
  });

  it('can select the unambiguous newest exact successful run', async () => {
    const tools = await loadModule<ReleaseStateModule>('../../tools/release/release-state.mjs');
    const base = {
      name: 'CI',
      path: '.github/workflows/ci.yml',
      head_sha: commit,
      event: 'push',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      head_repository: { full_name: 'Tom409114/scriptspect' },
      run_attempt: 1,
      html_url: 'https://example.invalid/run',
    };
    const expected = {
      sha: commit,
      workflowName: 'CI',
      workflowPath: '.github/workflows/ci.yml',
      event: 'push',
      branch: 'main',
      repository: 'Tom409114/scriptspect',
      selection: 'newest',
    };

    expect(
      tools.selectExactCiRun(
        {
          workflow_runs: [
            { ...base, id: 10, run_number: 2 },
            { ...base, id: 11, run_number: 3 },
          ],
        },
        expected,
      ),
    ).toMatchObject({ id: 11, runNumber: 3 });
  });

  it('offers the exact verify-ci flag interface used by release workflows', () => {
    const directory = temporaryDirectory('ci-cli');
    const runsPath = join(directory, 'runs.json');
    writeFileSync(
      runsPath,
      `${JSON.stringify({
        workflow_runs: [
          {
            id: 4001,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            head_sha: commit,
            event: 'push',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
            head_repository: { full_name: 'Tom409114/scriptspect' },
            run_number: 73,
            run_attempt: 1,
            html_url: 'https://github.com/Tom409114/scriptspect/actions/runs/4001',
          },
        ],
      })}\n`,
    );

    const stdout = execFileSync(
      process.execPath,
      [
        join(root, 'tools', 'release', 'release-state.mjs'),
        'verify-ci',
        '--runs',
        runsPath,
        '--sha',
        commit,
        '--repository',
        'Tom409114/scriptspect',
        '--workflow',
        'CI',
        '--event',
        'push',
        '--branch',
        'main',
      ],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(stdout)).toMatchObject({ id: 4001, sha: commit });
  });
});

describe('verified provenance audit selection', () => {
  function provenanceStatement(overrides: Record<string, unknown> = {}) {
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'pkg:npm/scriptspect@0.1.0',
          digest: { sha512: 'ab'.repeat(64) },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: {
            workflow: {
              ref: 'refs/heads/main',
              repository: 'https://github.com/Tom409114/scriptspect',
              path: '.github/workflows/release.yml',
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/Tom409114/scriptspect@refs/heads/main',
              digest: { gitCommit: commit },
            },
          ],
        },
        runDetails: {
          builder: { id: 'https://github.com/actions/runner/github-hosted' },
          metadata: {
            invocationId: 'https://github.com/Tom409114/scriptspect/actions/runs/9001/attempts/1',
          },
        },
      },
      ...overrides,
    };
  }

  function bundle(statement: unknown) {
    return {
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        verificationMaterial: { content: 'verified-by-npm-fixture' },
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          signatures: [{ sig: 'fixture-signature' }],
        },
      },
    };
  }

  const expected = {
    package: 'scriptspect',
    version: '0.1.0',
    predicateType: 'https://slsa.dev/provenance/v1',
    subjectDigest: { algorithm: 'sha512', value: 'ab'.repeat(64) },
    repository: 'https://github.com/Tom409114/scriptspect',
    workflowPath: '.github/workflows/release.yml',
    ref: 'refs/heads/main',
    commitSha: commit,
    builderId: 'https://github.com/actions/runner/github-hosted',
  };

  it('selects one exact npm-verified package attestation and validates one statement', async () => {
    const tools = await loadModule<ProvenanceModule>('../../tools/release/verify-provenance.mjs');
    const audit = {
      invalid: [],
      missing: [],
      verified: [
        { name: 'other', version: '9.0.0', attestationBundles: [] },
        {
          name: 'scriptspect',
          version: '0.1.0',
          attestations: {
            url: 'https://registry.npmjs.org/-/npm/v1/attestations/scriptspect@0.1.0',
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
          attestationBundles: [bundle(provenanceStatement())],
        },
      ],
    };

    expect(tools.verifyProvenanceAudit(audit, expected)).toMatchObject({
      package: 'scriptspect',
      version: '0.1.0',
      predicateType: 'https://slsa.dev/provenance/v1',
      statementDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('accepts the legacy nested bundle fixture but rejects two conflicting bundle sources', async () => {
    const tools = await loadModule<ProvenanceModule>('../../tools/release/verify-provenance.mjs');
    const goodBundle = bundle(provenanceStatement());
    const legacyAudit = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: 'scriptspect',
          version: '0.1.0',
          attestations: { bundles: [goodBundle] },
        },
      ],
    };
    expect(tools.verifyProvenanceAudit(legacyAudit, expected)).toMatchObject({
      package: 'scriptspect',
      version: '0.1.0',
    });

    const conflictingAudit = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: 'scriptspect',
          version: '0.1.0',
          attestationBundles: [goodBundle],
          attestations: {
            bundles: [
              bundle(
                provenanceStatement({
                  subject: [
                    {
                      name: 'pkg:npm/scriptspect@0.1.0',
                      digest: { sha512: 'cd'.repeat(64) },
                    },
                  ],
                }),
              ),
            ],
          },
        },
      ],
    };
    expect(() => tools.verifyProvenanceAudit(conflictingAudit, expected)).toThrow(
      /conflicting attestation bundle sources/i,
    );
  });

  it('does not combine repository and commit evidence from different statements', async () => {
    const tools = await loadModule<ProvenanceModule>('../../tools/release/verify-provenance.mjs');
    const wrongCommit = provenanceStatement();
    const predicate = wrongCommit.predicate as {
      buildDefinition: { resolvedDependencies: Array<{ digest: { gitCommit: string } }> };
    };
    const dependency = predicate.buildDefinition.resolvedDependencies[0];
    if (!dependency) throw new Error('provenance fixture dependency is missing');
    dependency.digest.gitCommit = '2'.repeat(40);
    const wrongRepository = provenanceStatement();
    const otherPredicate = wrongRepository.predicate as {
      buildDefinition: {
        externalParameters: { workflow: { repository: string } };
      };
    };
    otherPredicate.buildDefinition.externalParameters.workflow.repository =
      'https://github.com/attacker/fork';
    const audit = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: 'scriptspect',
          version: '0.1.0',
          attestationBundles: [bundle(wrongCommit), bundle(wrongRepository)],
        },
      ],
    };

    expect(() => tools.verifyProvenanceAudit(audit, expected)).toThrow(
      /no single verified provenance statement/i,
    );
  });

  it('runs as a strict JSON verifier CLI', () => {
    const directory = temporaryDirectory('provenance-cli');
    const auditPath = join(directory, 'audit.json');
    const expectedPath = join(directory, 'expected.json');
    writeFileSync(
      auditPath,
      `${JSON.stringify({
        invalid: [],
        missing: [],
        verified: [
          {
            name: 'scriptspect',
            version: '0.1.0',
            attestationBundles: [bundle(provenanceStatement())],
          },
        ],
      })}\n`,
    );
    writeFileSync(expectedPath, `${JSON.stringify(expected)}\n`);

    const stdout = execFileSync(
      process.execPath,
      [join(root, 'tools', 'release', 'verify-provenance.mjs'), auditPath, expectedPath],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(stdout)).toMatchObject({ package: 'scriptspect', version: '0.1.0' });
  });

  it('derives the exact subject digest from the tarball in the workflow flag CLI', () => {
    const directory = temporaryDirectory('provenance-flags');
    const tarballPath = join(directory, 'scriptspect-0.1.0.tgz');
    const auditPath = join(directory, 'audit.json');
    const tarball = Buffer.from('authoritative release asset fixture\n');
    writeFileSync(tarballPath, tarball);
    const statement = provenanceStatement({
      subject: [
        {
          name: 'pkg:npm/scriptspect@0.1.0',
          digest: { sha512: createHash('sha512').update(tarball).digest('hex') },
        },
      ],
    });
    writeFileSync(
      auditPath,
      `${JSON.stringify({
        invalid: [],
        missing: [],
        verified: [
          {
            name: 'scriptspect',
            version: '0.1.0',
            attestationBundles: [bundle(statement)],
          },
        ],
      })}\n`,
    );

    const stdout = execFileSync(
      process.execPath,
      [
        join(root, 'tools', 'release', 'verify-provenance.mjs'),
        '--audit',
        auditPath,
        '--package',
        'scriptspect',
        '--version',
        '0.1.0',
        '--tarball',
        tarballPath,
        '--repository',
        'Tom409114/scriptspect',
        '--workflow',
        '.github/workflows/release.yml',
        '--ref',
        'refs/heads/main',
        '--sha',
        commit,
      ],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(stdout)).toMatchObject({ package: 'scriptspect', version: '0.1.0' });
  });
});
