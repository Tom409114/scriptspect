import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const tool = resolve(root, 'tools/release/verify-npm-bootstrap-state.mjs');
const anchorTool = resolve(root, 'tools/release/verify-npm-bootstrap-anchor.mjs');
const sourceSha = 'a'.repeat(40);
const bootstrapVersion = '0.0.0-bootstrap.0';
const bootstrapTarball = `scriptspect-${bootstrapVersion}.tgz`;
const bootstrapTarballSha = 'efd8427d802796f53752d589719c967b0eb1a64227449f41ed5e438b46974c09';
const emptyDistTagsSha = 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356';

function verifyArtifactProvenance(
  overrides: {
    artifactHeadRepositoryId?: number;
    artifactHeadSha?: string;
    runBranch?: string;
    runEvent?: string;
    runPath?: string;
    runWorkflowId?: number;
  } = {},
): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-anchor-provenance-'));
  const artifactName = `npm-bootstrap-anchor-0.0.0-bootstrap.0-${sourceSha}`;
  const fixtures = {
    artifacts: {
      total_count: 1,
      artifacts: [
        {
          id: 101,
          name: artifactName,
          expired: false,
          digest: `sha256:${'b'.repeat(64)}`,
          workflow_run: {
            id: 202,
            repository_id: 303,
            head_repository_id: overrides.artifactHeadRepositoryId ?? 303,
            head_branch: 'main',
            head_sha: overrides.artifactHeadSha ?? sourceSha,
          },
        },
      ],
    },
    run: {
      id: 202,
      event: overrides.runEvent ?? 'workflow_dispatch',
      head_branch: overrides.runBranch ?? 'main',
      head_sha: sourceSha,
      path: overrides.runPath ?? '.github/workflows/npm-bootstrap.yml',
      workflow_id: overrides.runWorkflowId ?? 404,
      repository: { id: 303, full_name: 'Tom409114/scriptspect' },
      head_repository: { id: 303, full_name: 'Tom409114/scriptspect' },
    },
    workflow: {
      id: 404,
      path: '.github/workflows/npm-bootstrap.yml',
      state: 'active',
    },
    repository: { id: 303, full_name: 'Tom409114/scriptspect' },
  };
  const paths: Record<string, string> = {};
  for (const [name, value] of Object.entries(fixtures)) {
    paths[name] = join(directory, `${name}.json`);
    writeFileSync(paths[name], JSON.stringify(value));
  }
  try {
    return spawnSync(
      process.execPath,
      [
        anchorTool,
        'provenance',
        '--artifacts',
        paths.artifacts ?? '',
        '--run',
        paths.run ?? '',
        '--workflow',
        paths.workflow ?? '',
        '--repository',
        paths.repository ?? '',
        '--artifact-name',
        artifactName,
        '--repository-name',
        'Tom409114/scriptspect',
        '--source-sha',
        sourceSha,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyAnchorFiles(
  overrides: {
    anchorBasename?: string;
    anchorSha?: string;
    checksumBasename?: string;
    checksumSha?: string;
    distTagsBeforeDigest?: string;
    extraTarball?: boolean;
  } = {},
): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-anchor-files-'));
  writeFileSync(join(directory, bootstrapTarball), 'trusted bootstrap tarball\n');
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    `${overrides.checksumSha ?? bootstrapTarballSha}  ${
      overrides.checksumBasename ?? bootstrapTarball
    }\n`,
  );
  if (overrides.extraTarball === true) {
    writeFileSync(join(directory, 'scriptspect-0.0.0-bootstrap.1.tgz'), 'other tarball\n');
  }
  writeFileSync(join(directory, 'dist-tags-before.json'), '{}\n');
  writeFileSync(
    join(directory, 'bootstrap-anchor.json'),
    `${JSON.stringify({
      schemaVersion: 'scriptspect-bootstrap-anchor/v1',
      sourceCommit: sourceSha,
      version: bootstrapVersion,
      tarball: {
        basename: overrides.anchorBasename ?? bootstrapTarball,
        sha256: overrides.anchorSha ?? bootstrapTarballSha,
      },
      distTagsBeforeDigest: overrides.distTagsBeforeDigest ?? emptyDistTagsSha,
    })}\n`,
  );
  try {
    return spawnSync(
      process.execPath,
      [
        anchorTool,
        'files',
        '--directory',
        directory,
        '--source-sha',
        sourceSha,
        '--version',
        bootstrapVersion,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verify(input: {
  owners: unknown;
  before: unknown;
  after: unknown;
  owner?: string;
  version?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-bootstrap-'));
  const owners = join(directory, 'owners.json');
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  writeFileSync(owners, JSON.stringify(input.owners));
  writeFileSync(before, JSON.stringify(input.before));
  writeFileSync(after, JSON.stringify(input.after));
  try {
    return spawnSync(
      process.execPath,
      [
        tool,
        '--owners',
        owners,
        '--owner',
        input.owner ?? 'Tom409114',
        '--before',
        before,
        '--after',
        after,
        '--version',
        input.version ?? '0.0.0-bootstrap.0',
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function normalize(input: unknown, type: 'object' | 'string'): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-view-'));
  const inputPath = join(directory, 'input.json');
  writeFileSync(inputPath, JSON.stringify(input));
  try {
    return spawnSync(process.execPath, [tool, 'normalize', '--input', inputPath, '--type', type], {
      cwd: root,
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('npm bootstrap registry state verifier', () => {
  it('normalizes npm 11 values and npm 12 singleton result arrays', () => {
    for (const input of ['0.0.0-bootstrap.0', ['0.0.0-bootstrap.0']]) {
      const result = normalize(input, 'string');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('0.0.0-bootstrap.0\n');
    }

    for (const input of [{ latest: '1.2.3' }, [{ latest: '1.2.3' }]]) {
      const result = normalize(input, 'object');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ latest: '1.2.3' });
    }
  });

  it('can verify existing package ownership before any publication attempt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-owner-'));
    const owners = join(directory, 'owners.json');
    writeFileSync(owners, JSON.stringify(['Tom409114 <tom@example.test>']));
    try {
      const result = spawnSync(
        process.execPath,
        [tool, '--owners', owners, '--owner', 'Tom409114'],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ owner: 'Tom409114' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('normalizes npm maintainer JSON and accepts an idempotent post-publish retry', () => {
    for (const owners of [
      ['Tom409114 <tom@example.test>'],
      [['Tom409114 <tom@example.test>']],
      [{ name: 'Tom409114', email: 'tom@example.test' }],
      ['Tom409114 <tom@example.test>', { name: 'tom409114', email: 'same@example.test' }],
    ]) {
      const result = verify({
        owners,
        before: [{}],
        after: [{ bootstrap: '0.0.0-bootstrap.0' }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        owner: 'Tom409114',
        version: '0.0.0-bootstrap.0',
        latestBefore: null,
        latestAfter: null,
        bootstrap: '0.0.0-bootstrap.0',
      });
    }
  });

  it('rejects any additional maintainer after case-insensitive deduplication', () => {
    const result = verify({
      owners: [
        'Tom409114 <tom@example.test>',
        { name: 'attacker', email: 'attacker@example.test' },
      ],
      before: {},
      after: { bootstrap: '0.0.0-bootstrap.0' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('only the expected npm owner');
  });

  it('rejects a missing owner, a moved latest tag, or the wrong bootstrap tag', () => {
    const cases = [
      verify({
        owners: ['someone-else <else@example.test>'],
        before: {},
        after: { bootstrap: '0.0.0-bootstrap.0' },
      }),
      verify({
        owners: ['Tom409114 <tom@example.test>'],
        before: { latest: '1.2.3' },
        after: { latest: '1.2.4', bootstrap: '0.0.0-bootstrap.0' },
      }),
      verify({
        owners: ['Tom409114 <tom@example.test>'],
        before: {},
        after: { bootstrap: '0.0.0-bootstrap.1' },
      }),
    ];

    for (const result of cases) expect(result.status).not.toBe(0);
    expect(cases[0]?.stderr).toContain('authenticated npm owner is not a package maintainer');
    expect(cases[1]?.stderr).toContain('latest dist-tag changed during bootstrap');
    expect(cases[2]?.stderr).toContain('bootstrap dist-tag does not match the requested version');
  });
});

describe('npm bootstrap recovery anchor verifier', () => {
  it('accepts an anchor only from the exact trusted bootstrap workflow run', () => {
    const result = verifyArtifactProvenance();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      artifactId: 101,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      runId: 202,
      sourceCommit: sourceSha,
      workflowId: 404,
    });
  });

  it('rejects an artifact that is not bound to the exact trusted run identity', () => {
    const cases = [
      verifyArtifactProvenance({ artifactHeadRepositoryId: 999 }),
      verifyArtifactProvenance({ artifactHeadSha: 'c'.repeat(40) }),
      verifyArtifactProvenance({ runBranch: 'feature/untrusted' }),
      verifyArtifactProvenance({ runEvent: 'pull_request' }),
      verifyArtifactProvenance({ runPath: '.github/workflows/ci.yml' }),
      verifyArtifactProvenance({ runWorkflowId: 999 }),
    ];
    for (const result of cases) expect(result.status).not.toBe(0);
  });

  it('accepts one anchor whose manifest and checksum bind the exact tarball', () => {
    const result = verifyAnchorFiles();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sourceCommit: sourceSha,
      version: bootstrapVersion,
      tarball: { basename: bootstrapTarball, sha256: bootstrapTarballSha },
      distTagsBeforeDigest: emptyDistTagsSha,
    });
  });

  it('rejects ambiguous or self-inconsistent recovered anchor files', () => {
    const cases = [
      verifyAnchorFiles({ extraTarball: true }),
      verifyAnchorFiles({ anchorSha: 'c'.repeat(64) }),
      verifyAnchorFiles({ checksumSha: 'd'.repeat(64) }),
      verifyAnchorFiles({ checksumBasename: 'scriptspect-0.0.0-bootstrap.1.tgz' }),
      verifyAnchorFiles({ anchorBasename: 'scriptspect-0.0.0-bootstrap.1.tgz' }),
      verifyAnchorFiles({ distTagsBeforeDigest: 'e'.repeat(64) }),
    ];
    for (const result of cases) expect(result.status).not.toBe(0);
  });
});
