import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporaryDirectories: string[] = [];
const canonicalTreeAlgorithmDigest =
  'e4134401ced1d74c8f082a6a7950ef074d5a0ec9c24d6c1531a25254c9661ea3';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string | { name?: string };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  steps?: Step[];
  'timeout-minutes'?: number;
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, Job>;
};

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, unknown>;
}

function workflow(name: string): Workflow {
  return parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8')) as Workflow;
}

function source(name: string): string {
  return readFileSync(join(root, '.github', 'workflows', name), 'utf8');
}

function jobSource(name: string, job: string): string {
  return (workflow(name).jobs?.[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');
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

type IntegrityMode = 'exact-bytes' | 'canonical-tree-v1' | 'future-mode';

function integrityContract(mode: IntegrityMode, comparatorDigest = canonicalTreeAlgorithmDigest) {
  return {
    schemaVersion: 1,
    package: 'scriptspect',
    bootstrapVersion: '0.0.0-bootstrap.0',
    sourceCommit: '1'.repeat(40),
    integrityMode: mode,
    registryIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    comparatorAlgorithm: 'scriptspect-canonical-tree/v1',
    comparatorAlgorithmDigest: comparatorDigest,
    latestUnchanged: true,
    workflowRunUrl: 'https://github.com/Tom409114/scriptspect/actions/runs/1',
    reviewedAt: '2026-09-01T00:00:00Z',
  };
}

function npmSri(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

function integrityTarballs(name: string) {
  const directory = temporaryDirectory(name);
  const packageDirectory = join(directory, 'package');
  const changedDirectory = join(directory, 'changed', 'package');
  mkdirSync(packageDirectory);
  mkdirSync(changedDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    '{"name":"scriptspect","version":"0.1.0"}\n',
  );
  writeFileSync(
    join(changedDirectory, 'package.json'),
    '{"name":"scriptspect","version":"9.9.9"}\n',
  );

  const candidate = join(directory, 'candidate.tgz');
  const exactRegistry = join(directory, 'registry-exact.tgz');
  const repackedRegistry = join(directory, 'registry-repacked.tgz');
  const changedRegistry = join(directory, 'registry-changed.tgz');
  const archive = spawnSync('tar', ['-czf', candidate, '-C', directory, 'package'], {
    encoding: 'utf8',
  });
  if (archive.status !== 0) {
    throw new Error(`tar fixture failed: ${archive.stderr}`);
  }
  const changedArchive = spawnSync(
    'tar',
    ['-czf', changedRegistry, '-C', join(directory, 'changed'), 'package'],
    { encoding: 'utf8' },
  );
  if (changedArchive.status !== 0) {
    throw new Error(`changed tar fixture failed: ${changedArchive.stderr}`);
  }
  copyFileSync(candidate, exactRegistry);
  const repacked = Buffer.from(readFileSync(candidate));
  if (repacked[0] !== 0x1f || repacked[1] !== 0x8b) {
    throw new Error('tar fixture is not gzip compressed');
  }
  repacked[9] = repacked[9] === 3 ? 0 : 3;
  writeFileSync(repackedRegistry, repacked);
  return { directory, candidate, exactRegistry, repackedRegistry, changedRegistry };
}

function runIntegrityVerifier(
  contract: Record<string, unknown>,
  candidate: string,
  registry: string,
  registrySri = npmSri(registry),
) {
  const contractPath = join(dirname(candidate), `contract-${String(contract.integrityMode)}.json`);
  writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
  return spawnSync(
    process.execPath,
    [
      join(root, 'tools', 'release', 'verify-package-integrity.mjs'),
      '--contract',
      contractPath,
      '--candidate',
      candidate,
      '--registry',
      registry,
      '--candidate-sri',
      npmSri(candidate),
      '--registry-sri',
      registrySri,
    ],
    { encoding: 'utf8' },
  );
}

describe('release pull requests and exact release intent', () => {
  it('configures release-please to update only a release PR', () => {
    const config = json('release-please-config.json');
    const packages = config.packages as Record<string, Record<string, unknown>>;
    expect(packages['.']).toMatchObject({
      'release-type': 'node',
      'initial-version': '0.1.0',
      'include-component-in-tag': false,
      'include-v-in-tag': true,
      'skip-github-release': true,
    });

    const releasePr = workflow('release-pr.yml');
    expect(releasePr.on).toHaveProperty('push');
    expect(releasePr.jobs).toHaveProperty('release-please');
    expect(source('release-pr.yml')).not.toContain('npm publish');
    expect(source('release-pr.yml')).not.toContain('gh release');
    expect(source('release-pr.yml')).toContain('RELEASE_PR_CI_MODE');
    expect(source('release-pr.yml')).toContain('manual-approval');
    expect(source('release-pr.yml')).toContain('github-app');
    expect(source('release-pr.yml')).toContain('actions/create-github-app-token@');
    const appToken = releasePr.jobs?.['release-please']?.steps?.find((step) =>
      step.uses?.startsWith('actions/create-github-app-token@'),
    );
    expect(appToken?.with).toMatchObject({
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(appToken?.with).not.toHaveProperty('permission-issues');
  });

  it('records one queryable intent for the exact merged release PR commit', () => {
    const intent = workflow('release-intent.yml');
    expect(intent.on).toMatchObject({ push: { branches: ['main'] } });
    expect(intent.permissions).toMatchObject({
      contents: 'read',
      checks: 'write',
      'pull-requests': 'read',
    });

    const run = jobSource('release-intent.yml', 'record-intent');
    for (const field of [
      'prNumber',
      'mergeCommitSha',
      'version',
      'tag',
      'packageManifestHash',
      'changelogHash',
      'releasePleaseManifestHash',
      'releasePrHeadRepo',
      'releasePrHeadSha',
    ]) {
      expect(run).toContain(field);
    }
    expect(run).toContain('/check-runs');
    expect(run).toContain('release-intent');
    expect(run).toContain('RELEASE_PR_ACTORS');
    expect(run).not.toContain('autorelease: pending');
    expect(run).toContain('merge_commit_sha');
    expect(run).toContain('RELEASE_PULL_COUNT');
    expect(run).toContain('No merged release-please PR');
    expect(run).toContain('.head.repo.full_name == $repository');
    expect(run).toContain('.head.repo.fork == false');
  });

  it('publishes repository metadata in npm trusted-publisher canonical form', () => {
    expect(json('package.json').repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Tom409114/scriptspect.git',
    });
  });
});

describe('release coordinator trust and recovery', () => {
  it('accepts only successful main push CI for the exact intent SHA or an approved exact dispatch', () => {
    const release = workflow('release.yml');
    expect(release.on).toMatchObject({
      workflow_run: { workflows: ['CI'], types: ['completed'] },
    });
    expect(release.on).toHaveProperty('workflow_dispatch');
    expect(release.permissions).toEqual({ contents: 'read' });

    const authorize = jobSource('release.yml', 'authorize');
    for (const predicate of [
      'conclusion',
      'success',
      'event',
      'push',
      'head_branch',
      'main',
      'head_repository.full_name',
      'head_sha',
      'mergeCommitSha',
      'merge-base --is-ancestor',
    ]) {
      expect(authorize).toContain(predicate);
    }
    expect(authorize).toContain('workflow_dispatch');
    expect(authorize).toContain('INTENT_ID');
    expect(authorize).toContain('PR_NUMBER');
    expect(authorize).toContain('actions/workflows/ci.yml/runs');
    expect(authorize).toContain('verify-ci');
    const bootstrap = jobSource('npm-bootstrap.yml', 'bootstrap');
    expect(bootstrap).toContain('actions/workflows/ci.yml/runs');
    expect(bootstrap).toContain('verify-ci');
  });

  it('blocks formal publication until the bootstrap integrity contract is committed', () => {
    const authorize = jobSource('release.yml', 'authorize');
    expect(authorize).toContain('docs/release/npm-integrity-contract.json');
    expect(authorize).toContain('integrityMode');
    expect(authorize).toContain('bootstrapVersion');

    const verify = jobSource('npm-publish.yml', 'publish');
    expect(verify).toContain('verify-package-integrity.mjs');
    expect(source('release.yml')).not.toContain('vars.NPM_INTEGRITY_MODE');
    expect(authorize).toContain('NPM_BOOTSTRAP_ENABLED');
    expect(authorize).toContain('NPM_TRUSTED_PUBLISHING_READY');
  });

  it('enforces exact bytes and both calculated and registry SRI in exact-bytes mode', () => {
    const { candidate, exactRegistry, repackedRegistry } = integrityTarballs('integrity-exact');
    const contract = integrityContract('exact-bytes');

    const exact = runIntegrityVerifier(contract, candidate, exactRegistry);
    expect(exact.status, exact.stderr).toBe(0);
    expect(JSON.parse(exact.stdout)).toMatchObject({
      integrityMode: 'exact-bytes',
      candidateNpmSRI: npmSri(candidate),
      registryNpmSRI: npmSri(exactRegistry),
      byteEqual: true,
    });

    const repacked = runIntegrityVerifier(contract, candidate, repackedRegistry);
    expect(repacked.status).toBe(1);
    expect(repacked.stderr).toMatch(/exact-bytes.*byte equality/i);

    const falseRegistryMetadata = runIntegrityVerifier(
      contract,
      candidate,
      exactRegistry,
      `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
    );
    expect(falseRegistryMetadata.status).toBe(1);
    expect(falseRegistryMetadata.stderr).toMatch(/registry SRI.*registry tarball bytes/i);

    const contractPath = join(dirname(candidate), 'contract-false-candidate-sri.json');
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    const falseCandidateMetadata = spawnSync(
      process.execPath,
      [
        join(root, 'tools', 'release', 'verify-package-integrity.mjs'),
        '--contract',
        contractPath,
        '--candidate',
        candidate,
        '--registry',
        exactRegistry,
        '--candidate-sri',
        `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
        '--registry-sri',
        npmSri(exactRegistry),
      ],
      { encoding: 'utf8' },
    );
    expect(falseCandidateMetadata.status).toBe(1);
    expect(falseCandidateMetadata.stderr).toMatch(/candidate SRI.*candidate tarball bytes/i);
  });

  it('permits repacked bytes only when canonical trees match the reviewed algorithm digest', () => {
    const { candidate, repackedRegistry, changedRegistry } =
      integrityTarballs('integrity-canonical');
    const contract = integrityContract('canonical-tree-v1');
    expect(npmSri(candidate)).not.toBe(npmSri(repackedRegistry));

    const repacked = runIntegrityVerifier(contract, candidate, repackedRegistry);
    expect(repacked.status, repacked.stderr).toBe(0);
    expect(JSON.parse(repacked.stdout)).toMatchObject({
      integrityMode: 'canonical-tree-v1',
      comparatorAlgorithm: 'scriptspect-canonical-tree/v1',
      comparatorAlgorithmDigest: canonicalTreeAlgorithmDigest,
      treeEqual: true,
      byteEqual: false,
    });

    const changed = runIntegrityVerifier(contract, candidate, changedRegistry);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toMatch(/canonical-tree-v1.*tree digest equality/i);
  });

  it('fails closed for an unknown mode or an unreviewed comparator digest', () => {
    const { candidate, exactRegistry } = integrityTarballs('integrity-fail-closed');

    const unknownMode = runIntegrityVerifier(
      integrityContract('future-mode'),
      candidate,
      exactRegistry,
    );
    expect(unknownMode.status).toBe(1);
    expect(unknownMode.stderr).toMatch(/unsupported integrity mode/i);

    const driftedDigest = runIntegrityVerifier(
      integrityContract('canonical-tree-v1', 'f'.repeat(64)),
      candidate,
      exactRegistry,
    );
    expect(driftedDigest.status).toBe(1);
    expect(driftedDigest.stderr).toMatch(/comparator algorithm digest/i);
  });

  it('verifies the reviewed integrity mode before recording npm publication', () => {
    const publish = jobSource('npm-publish.yml', 'publish');
    const verifier = 'verify-package-integrity.mjs';
    const transition = 'published-transition.json';

    expect(publish).toContain('docs/release/npm-integrity-contract.json');
    expect(publish).toContain(verifier);
    expect(publish.indexOf(verifier)).toBeLessThan(publish.indexOf(transition));
    expect(publish).not.toContain('[[ "$EXISTING_SRI" == "$CANDIDATE_SRI" ]]');
    expect(publish).not.toContain('[[ "$REGISTRY_SRI" == "$CANDIDATE_SRI" ]]');
  });

  it('serializes every mutating transition by the verified version', () => {
    expect(workflow('release-intent.yml').jobs?.['record-intent']?.concurrency).toEqual({
      group: `release-state-\${{ github.repository }}-\${{ github.sha }}`,
      'cancel-in-progress': false,
    });
    const release = workflow('release.yml');
    for (const jobName of ['build-candidate', 'stage-release']) {
      expect(release.jobs?.[jobName]?.concurrency).toEqual({
        group: `release-state-\${{ github.repository }}-\${{ needs.authorize.outputs.sha }}`,
        'cancel-in-progress': false,
      });
    }
    const publisher = workflow('npm-publish.yml');
    expect(publisher.jobs?.publish?.concurrency).toEqual({
      group: `release-state-\${{ github.repository }}-\${{ github.sha }}`,
      'cancel-in-progress': false,
    });
    expect(publisher.jobs?.['record-verification']?.concurrency).toEqual({
      group: `release-state-\${{ github.repository }}-\${{ needs.publish.outputs.sha }}`,
      'cancel-in-progress': false,
    });
  });

  it('stages one authoritative draft asset and checksums before npm access', () => {
    const release = workflow('release.yml');
    expect(release.jobs?.['stage-release']).toBeDefined();

    const stage = jobSource('release.yml', 'stage-release');
    expect(stage).toContain('--draft');
    expect(stage).toContain('candidate-manifest.json');
    expect(stage).toContain('release-manifest.json');
    expect(stage).toContain('SHA256SUMS');
    expect(stage).not.toContain('--clobber');

    expect(source('release.yml')).not.toContain('npm publish');
    const publish = jobSource('npm-publish.yml', 'publish');
    expect(publish).toContain('gh release download');
    expect(publish).toContain('release-manifest.json');
    expect(publish).toContain('verify-publish-anchors');
    expect(publish).toContain('sha256sum --check');
    expect(publish).toContain('npm publish "$RUNNER_TEMP/release/$TARBALL"');
    expect(publish).toContain('--provenance');
    expect(publish).not.toContain('NPM_TOKEN');
    expect(workflow('npm-publish.yml').jobs?.publish?.permissions).toMatchObject({
      contents: 'read',
      'id-token': 'write',
      checks: 'write',
    });
  });

  it('creates the immutable tag through the create-only refs API and verifies 422 retries', () => {
    const stage = jobSource('release.yml', 'stage-release');
    expect(stage).toContain('git/refs');
    expect(stage).toContain('refs/tags/$TAG');
    expect(stage).toContain('HTTP_STATUS');
    expect(stage).toContain('422');
    expect(stage).toContain('git/ref/tags/$TAG');
    expect(stage).toContain('object.sha == $sha');
    expect(stage).not.toContain('git push');
  });

  it('runs trusted publication only from the exact immutable tag event context', () => {
    const publisher = workflow('npm-publish.yml');
    expect(publisher.on).toMatchObject({ push: { tags: ['v[0-9]+.[0-9]+.[0-9]+'] } });
    expect(publisher.on).toHaveProperty('workflow_dispatch');
    expect(publisher.jobs?.publish?.environment).toBe('release');
    const run = jobSource('npm-publish.yml', 'publish');
    for (const predicate of [
      'refs/tags/$TAG',
      'GITHUB_REF',
      'GITHUB_SHA',
      'verify-ci',
      'release-intent',
      'staged-draft',
      '.head.repo.full_name == $repository',
      '.head.repo.fork == false',
      'verify-publish-anchors',
    ]) {
      expect(run).toContain(predicate);
    }
    expect(run.indexOf('verify-publish-anchors')).toBeLessThan(run.indexOf('npm publish'));
    expect(jobSource('release.yml', 'authorize')).toContain('releasePrHeadRepo');
    expect(jobSource('release.yml', 'authorize')).toContain('releasePrHeadSha');
  });

  it('durably anchors every recoverable state transition outside runner storage', () => {
    const release = `${source('release.yml')}\n${source('npm-publish.yml')}`;
    for (const anchor of [
      'runId',
      'artifactId',
      'artifactDigest',
      'candidateManifestDigest',
      'npmSRI',
      'releaseId',
      'assetId',
      'releaseManifestDigest',
    ]) {
      expect(release).toContain(anchor);
    }
    for (const state of [
      'retained-candidate',
      'staged-draft',
      'npm-published',
      'npm-verified',
      'aliases-verified',
      'consumed',
    ]) {
      expect(release).toContain(state);
    }
    expect(release).toContain('recovery-decision');
    expect(release).toContain('compare-and-update');
  });

  it('keeps aliases unchanged until registry and immutable-tag consumers pass', () => {
    const publisher = workflow('npm-publish.yml');
    const finalize = jobSource('npm-publish.yml', 'advance-aliases');
    expect(finalize).toContain('MINOR_ALIAS');
    expect(finalize).toContain('MAJOR_ALIAS="v$MAJOR"');
    expect(finalize).toContain('--force-with-lease');
    expect(finalize).not.toContain('v1');
    expect(finalize).toContain('gh release edit');
    expect(finalize).toContain('--draft=false');
    expect(finalize).not.toContain("':refs/tags/v0.1'");
    expect(source('npm-publish.yml')).not.toContain('git push origin ":refs/tags/');
    expect(publisher.jobs?.publish?.concurrency).toBeDefined();
    expect(source('npm-publish.yml')).toContain(`release-aliases-\${{ github.repository }}`);
    expect(finalize).toContain('semver-monotonic');
    expect(finalize).toContain('merge-base --is-ancestor');
  });

  it('decodes the signed SLSA statement before matching repository and commit', () => {
    const verify = jobSource('npm-publish.yml', 'publish');
    expect(verify).toContain('npm audit signatures --json --include-attestations');
    expect(verify).toContain('verify-provenance');
    expect(verify).toContain('scriptspect@');
    expect(verify).toContain('registry.tgz');
  });

  it('marks the exact intent consumed only after attaching final verification', () => {
    const record = jobSource('npm-publish.yml', 'record-verification');
    expect(record).toContain('final-verification.json');
    expect(record).toContain('gh release upload');
    expect(record).toContain('/check-runs/');
    expect(record).toContain('consumed');
    expect(record).toContain('final-idempotency');
  });
});

describe('one-time npm bootstrap', () => {
  it('is manual, separately approved, prerelease-only, and never moves latest', () => {
    const bootstrap = workflow('npm-bootstrap.yml');
    expect(bootstrap.on).toHaveProperty('workflow_dispatch');
    expect(bootstrap.jobs?.bootstrap?.environment).toBe('npm-bootstrap');

    const run = jobSource('npm-bootstrap.yml', 'bootstrap');
    expect(source('npm-bootstrap.yml')).toContain('default: 0.0.0-bootstrap.0');
    expect(run).toContain('--tag bootstrap');
    expect(run).toContain('npm dist-tag ls');
    expect(run).toContain('NPM_BOOTSTRAP_TOKEN');
    expect(source('npm-bootstrap.yml')).toContain('registry-url: https://registry.npmjs.org');
    expect(run).toContain('npm version "$VERSION"');
    expect(run).toContain('pnpm build');
    expect(run.indexOf('npm version "$VERSION"')).toBeLessThan(run.indexOf('pnpm build'));
    expect(run).toContain('already-published');
    expect(run).toContain('node_modules/scriptspect/dist/cli.mjs');
    expect(run).toContain('node_modules/scriptspect/schema/config.schema.json');
    expect(run).toContain('node_modules/scriptspect/dist/action.mjs');
    expect(run).toContain('canonical-tree');
    expect(run).toContain('comparatorAlgorithmDigest');
    expect(bootstrap.jobs?.bootstrap?.concurrency).toEqual({
      group: `npm-bootstrap-\${{ github.repository }}`,
      'cancel-in-progress': false,
    });
    expect(run).toContain('bootstrap-anchor.json');
    expect(run).toContain('dist-tags-before.json');
    expect(run).toContain('actions/artifacts');
    expect(run).toContain('sha256sum --check SHA256SUMS');
    expect(run).toContain('canonical-tree.mjs digest --tarball');
    expect(run.indexOf('bootstrap-anchor.json')).toBeLessThan(run.indexOf('npm publish'));
    expect(run).toMatch(/sha256sum "\$TARBALL_BASENAME" > SHA256SUMS/);
    expect(run).not.toMatch(/sha256sum "\$TARBALL" > .*SHA256SUMS/);
    expect(run).not.toMatch(/npm publish[^\n]*0\.1\.0/);
    expect(source('release.yml')).not.toContain('NPM_BOOTSTRAP_TOKEN');
  });
});
