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
const canonicalTreeDigestProcess = spawnSync(
  process.execPath,
  [join(root, 'tools', 'release', 'canonical-tree.mjs'), 'algorithm-digest'],
  { encoding: 'utf8' },
);
if (canonicalTreeDigestProcess.status !== 0) {
  throw new Error(`canonical tree digest failed: ${canonicalTreeDigestProcess.stderr}`);
}
const canonicalTreeAlgorithmDigest = (
  JSON.parse(canonicalTreeDigestProcess.stdout) as { algorithmDigest: string }
).algorithmDigest;

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string | { name?: string };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean; queue?: string };
  permissions?: Record<string, string>;
  steps?: Step[];
  'timeout-minutes'?: number;
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean; queue?: string };
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
  verifier = join(root, 'tools', 'release', 'verify-package-integrity.mjs'),
) {
  const contractPath = join(dirname(candidate), `contract-${String(contract.integrityMode)}.json`);
  writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
  return spawnSync(
    process.execPath,
    [
      verifier,
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

function releasePullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base: { ref: 'main', repo: { full_name: 'Tom409114/scriptspect' } },
    head: {
      ref: 'release-please--branches--main--components--scriptspect',
      repo: { full_name: 'Tom409114/scriptspect', fork: false },
    },
    title: 'chore(main): release 0.1.0',
    user: { login: 'github-actions[bot]' },
    labels: [{ name: 'autorelease: pending' }],
    ...overrides,
  };
}

function runReleaseReadiness(options: {
  pullRequest: Record<string, unknown>;
  contract?: Record<string, unknown>;
  bootstrap?: string;
  trusted?: string;
  tagPolicy?: string;
  actors?: string;
  writeContract?: boolean;
  omitFlag?: string;
  extraArgs?: string[];
}) {
  const directory = temporaryDirectory('release-readiness');
  const eventPath = join(directory, 'event.json');
  const contractPath = join(directory, 'contract.json');
  writeFileSync(eventPath, `${JSON.stringify({ pull_request: options.pullRequest })}\n`);
  if (options.writeContract !== false) {
    writeFileSync(
      contractPath,
      `${JSON.stringify(options.contract ?? integrityContract('exact-bytes'))}\n`,
    );
  }
  const arguments_ = [
    '--event',
    eventPath,
    '--contract',
    contractPath,
    '--repository',
    'Tom409114/scriptspect',
    '--release-pr-actors',
    options.actors ?? 'github-actions[bot]',
    '--npm-bootstrap-enabled',
    options.bootstrap ?? 'false',
    '--npm-trusted-publishing-ready',
    options.trusted ?? 'true',
    '--release-tag-policy-ready',
    options.tagPolicy ?? 'true',
  ];
  if (options.omitFlag !== undefined) {
    const index = arguments_.indexOf(`--${options.omitFlag}`);
    if (index === -1) throw new Error(`test attempted to omit unknown flag ${options.omitFlag}`);
    arguments_.splice(index, 2);
  }
  arguments_.push(...(options.extraArgs ?? []));
  return spawnSync(
    process.execPath,
    [join(root, 'tools', 'release', 'release-pr-readiness.mjs'), ...arguments_],
    { encoding: 'utf8' },
  );
}

function runContractOnly(contract: Record<string, unknown>) {
  const directory = temporaryDirectory('contract-only');
  const contractPath = join(directory, 'contract.json');
  writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
  return spawnSync(
    process.execPath,
    [
      join(root, 'tools', 'release', 'verify-package-integrity.mjs'),
      '--contract-only',
      contractPath,
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
  it('short-circuits ordinary main CI before requesting the release environment', () => {
    const release = workflow('release.yml');
    const discover = release.jobs?.['discover-intent'];
    const discoverRun = jobSource('release.yml', 'discover-intent');
    const authorize = release.jobs?.authorize;

    expect(discover).toBeDefined();
    expect(discover?.environment).toBeUndefined();
    expect(discover?.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
    });
    expect(discoverRun).toContain('actions/workflows/release-intent.yml/runs');
    expect(discoverRun).toContain('has-intent=false');
    expect(discoverRun).toContain('check-runs?check_name=release-intent');
    expect(discoverRun).toContain('exit 1');

    expect(authorize?.needs).toEqual(['discover-intent']);
    expect(authorize?.if).toContain('!cancelled()');
    expect(authorize?.if).not.toContain('always()');
    expect(authorize?.if).toContain("needs.discover-intent.result == 'success'");
    expect(authorize?.if).toContain("needs.discover-intent.outputs.has-intent == 'true'");
    expect(authorize?.environment).toBe('release');
  });

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
    expect(authorize).toContain('--contract-only');
    expect(
      readFileSync(join(root, 'tools', 'release', 'verify-package-integrity.mjs'), 'utf8'),
    ).toContain('bootstrapVersion');

    const verify = jobSource('npm-publish.yml', 'publish');
    expect(verify).toContain('verify-package-integrity.mjs');
    expect(source('release.yml')).not.toContain('vars.NPM_INTEGRITY_MODE');
    expect(authorize).toContain('NPM_BOOTSTRAP_ENABLED');
    expect(authorize).toContain('NPM_TRUSTED_PUBLISHING_READY');
  });

  it('keeps the release PR blocked until every external publication control is ready', () => {
    const readiness = workflow('release-readiness.yml');
    expect(readiness.on).toMatchObject({
      pull_request_target: { branches: ['main'] },
    });
    expect(readiness.permissions).toEqual({ contents: 'read' });
    expect(readiness.jobs).toHaveProperty('release-pr-readiness');
    const readinessCheckout = readiness.jobs?.['release-pr-readiness']?.steps?.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(readinessCheckout).toBeDefined();
    expect(readinessCheckout?.with ?? {}).not.toHaveProperty('ref');
    expect(readinessCheckout?.with).toMatchObject({ 'persist-credentials': false });

    const gate = jobSource('release-readiness.yml', 'release-pr-readiness');
    for (const predicate of [
      'release-pr-readiness.mjs',
      'docs/release/npm-integrity-contract.json',
    ]) {
      expect(gate).toContain(predicate);
    }
    const readinessSource = source('release-readiness.yml');
    expect(readinessSource).not.toContain('github.event.pull_request.base.sha');
    expect(readinessSource).not.toContain('github.event.pull_request.head.sha');
    expect(readinessSource).not.toContain('github.event.pull_request.head.ref');
    expect(readinessSource).toContain('node-version: 22');

    const authorize = jobSource('release.yml', 'authorize');
    expect(authorize).toContain('[[ "$NPM_BOOTSTRAP_ENABLED" == false ]]');
    expect(authorize).toContain('RELEASE_TAG_POLICY_READY');
    expect(authorize).toContain('[[ "$RELEASE_TAG_POLICY_READY" == true ]]');

    const publish = jobSource('npm-publish.yml', 'publish');
    expect(publish).toContain('[[ "$NPM_BOOTSTRAP_ENABLED" == false ]]');
    expect(publish).toContain('[[ "$NPM_TRUSTED_PUBLISHING_READY" == true ]]');
    expect(publish).toContain('[[ "$RELEASE_TAG_POLICY_READY" == true ]]');
  });

  it('executes the release readiness decision across identity and external-control boundaries', () => {
    const ready = runReleaseReadiness({ pullRequest: releasePullRequest() });
    expect(ready.status, ready.stderr).toBe(0);
    expect(JSON.parse(ready.stdout)).toMatchObject({ applicable: true, ready: true });

    const ordinary = runReleaseReadiness({
      pullRequest: releasePullRequest({
        head: {
          ref: 'feat/ordinary-change',
          repo: { full_name: 'Tom409114/scriptspect', fork: false },
        },
        title: 'feat: ordinary change',
        user: { login: 'contributor' },
        labels: [],
      }),
      bootstrap: '',
      trusted: '',
      tagPolicy: '',
      writeContract: false,
    });
    expect(ordinary.status, ordinary.stderr).toBe(0);
    expect(JSON.parse(ordinary.stdout)).toMatchObject({ applicable: false, ready: true });

    const missingContract = runReleaseReadiness({
      pullRequest: releasePullRequest(),
      writeContract: false,
    });
    expect(missingContract.status).toBe(1);
    expect(missingContract.stderr).toMatch(/integrity contract.*read/i);

    const blockedCases: Array<[string, ReturnType<typeof runReleaseReadiness>, RegExp]> = [
      [
        'unset bootstrap switch',
        runReleaseReadiness({ pullRequest: releasePullRequest(), bootstrap: '' }),
        /NPM_BOOTSTRAP_ENABLED/,
      ],
      [
        'enabled bootstrap switch',
        runReleaseReadiness({ pullRequest: releasePullRequest(), bootstrap: 'true' }),
        /NPM_BOOTSTRAP_ENABLED/,
      ],
      [
        'unready trusted publishing',
        runReleaseReadiness({ pullRequest: releasePullRequest(), trusted: 'false' }),
        /NPM_TRUSTED_PUBLISHING_READY/,
      ],
      [
        'unready tag policy',
        runReleaseReadiness({ pullRequest: releasePullRequest(), tagPolicy: 'false' }),
        /RELEASE_TAG_POLICY_READY/,
      ],
      [
        'unapproved actor',
        runReleaseReadiness({
          pullRequest: releasePullRequest({ user: { login: 'attacker' } }),
        }),
        /actor is not in/,
      ],
      [
        'renamed branch',
        runReleaseReadiness({
          pullRequest: releasePullRequest({
            head: {
              ref: 'release-tool-renamed-branch',
              repo: { full_name: 'Tom409114/scriptspect', fork: false },
            },
          }),
        }),
        /head branch must start/,
      ],
      [
        'noncanonical title',
        runReleaseReadiness({
          pullRequest: releasePullRequest({ title: 'release 0.1.0' }),
        }),
        /canonical release-please title/,
      ],
      [
        'missing release label',
        runReleaseReadiness({ pullRequest: releasePullRequest({ labels: [] }) }),
        /label autorelease: pending is missing/,
      ],
      [
        'wrong base ref',
        runReleaseReadiness({
          pullRequest: releasePullRequest({
            base: { ref: 'develop', repo: { full_name: 'Tom409114/scriptspect' } },
          }),
        }),
        /base ref must be main/,
      ],
      [
        'wrong base repository',
        runReleaseReadiness({
          pullRequest: releasePullRequest({
            base: { ref: 'main', repo: { full_name: 'attacker/fork' } },
          }),
        }),
        /base repository does not match/,
      ],
      [
        'wrong head repository',
        runReleaseReadiness({
          pullRequest: releasePullRequest({
            head: {
              ref: 'release-please--branches--main--components--scriptspect',
              repo: { full_name: 'attacker/fork', fork: false },
            },
          }),
        }),
        /head must be a non-fork branch/,
      ],
      [
        'forked head repository',
        runReleaseReadiness({
          pullRequest: releasePullRequest({
            head: {
              ref: 'release-please--branches--main--components--scriptspect',
              repo: { full_name: 'Tom409114/scriptspect', fork: true },
            },
          }),
        }),
        /head must be a non-fork branch/,
      ],
    ];
    for (const [description, blocked, message] of blockedCases) {
      expect(blocked.status, description).toBe(1);
      expect(blocked.stderr, description).toMatch(message);
    }
  });

  it('uses the publisher contract parser for pre-merge readiness', () => {
    const valid = runContractOnly(integrityContract('exact-bytes'));
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      package: 'scriptspect',
      integrityMode: 'exact-bytes',
    });

    const missingRegistryIntegrity = integrityContract('exact-bytes');
    delete (missingRegistryIntegrity as Record<string, unknown>).registryIntegrity;
    const contractOnlyMissing = runContractOnly(missingRegistryIntegrity);
    expect(contractOnlyMissing.status).toBe(1);
    expect(contractOnlyMissing.stderr).toContain('registryIntegrity');

    const missing = runReleaseReadiness({
      pullRequest: releasePullRequest(),
      contract: missingRegistryIntegrity,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('registryIntegrity');

    const wrongDigest = runReleaseReadiness({
      pullRequest: releasePullRequest(),
      contract: integrityContract('exact-bytes', 'f'.repeat(64)),
    });
    expect(wrongDigest.status).toBe(1);
    expect(wrongDigest.stderr).toMatch(/comparator.*digest/i);
  });

  it('rejects missing, duplicate, and unknown readiness CLI flags', () => {
    const malformed = [
      runReleaseReadiness({
        pullRequest: releasePullRequest(),
        omitFlag: 'release-tag-policy-ready',
      }),
      runReleaseReadiness({
        pullRequest: releasePullRequest(),
        extraArgs: ['--repository', 'Tom409114/scriptspect'],
      }),
      runReleaseReadiness({
        pullRequest: releasePullRequest(),
        extraArgs: ['--unexpected', 'true'],
      }),
    ];
    expect(malformed[0]?.status).toBe(1);
    expect(malformed[0]?.stderr).toContain('missing --release-tag-policy-ready');
    expect(malformed[1]?.status).toBe(1);
    expect(malformed[1]?.stderr).toContain('duplicate --repository');
    expect(malformed[2]?.status).toBe(1);
    expect(malformed[2]?.stderr).toContain('unknown --unexpected');
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
      comparatorSourceBundle: {
        schemaVersion: 'scriptspect-canonical-tree-source-bundle/v1',
        digest: canonicalTreeAlgorithmDigest,
        files: [{ path: 'canonical-tree.mjs' }, { path: 'shared.mjs' }],
      },
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

  it('rejects source drift that leaves the declarative behavior vectors unchanged', () => {
    const { candidate, exactRegistry } = integrityTarballs('integrity-source-drift');
    const releaseDirectory = join(temporaryDirectory('integrity-drifted-tools'), 'release');
    mkdirSync(releaseDirectory);
    for (const name of ['verify-package-integrity.mjs', 'shared.mjs']) {
      copyFileSync(join(root, 'tools', 'release', name), join(releaseDirectory, name));
    }
    const comparatorPath = join(root, 'tools', 'release', 'canonical-tree.mjs');
    const comparator = readFileSync(comparatorPath, 'utf8');
    const drifted = comparator.replace(
      'canonical tree root must be a directory',
      'canonical tree input root must be a directory',
    );
    expect(drifted).not.toBe(comparator);
    writeFileSync(join(releaseDirectory, 'canonical-tree.mjs'), drifted);

    const result = runIntegrityVerifier(
      integrityContract('canonical-tree-v1'),
      candidate,
      exactRegistry,
      npmSri(exactRegistry),
      join(releaseDirectory, 'verify-package-integrity.mjs'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /comparator algorithm digest does not match the executable comparator/i,
    );
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

  it('builds the candidate before tests that consume generated CLI and Action bundles', () => {
    const candidate = jobSource('release.yml', 'build-candidate');
    const build = candidate.indexOf('pnpm build');
    const test = candidate.indexOf('pnpm exec vitest run');

    expect(build).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(build);
  });

  it('packs exact-version bilingual npm READMEs without changing the repository homepages', () => {
    const releaseCandidate = jobSource('release.yml', 'build-candidate');
    const bootstrapCandidate = jobSource('npm-bootstrap.yml', 'bootstrap');
    const publisher = jobSource('npm-publish.yml', 'publish');

    for (const candidate of [releaseCandidate, bootstrapCandidate]) {
      expect(candidate).toContain('tools/release/generate-package-readmes.mjs');
      expect(candidate).toContain('package-stage');
      expect(candidate).toContain('git archive');
      expect(candidate).toContain('cp -R dist schema "$PACKAGE_STAGE/"');
      expect(candidate).toContain('git diff --exit-code -- README.md README.zh-CN.md');
      expect(candidate.indexOf('tools/release/generate-package-readmes.mjs')).toBeLessThan(
        candidate.indexOf('pnpm pack'),
      );
      expect(candidate).toContain('tar -xOf');
      expect(candidate).toContain('README.zh-CN.md');
    }
    expect(releaseCandidate).toContain('npx --yes scriptspect@$VERSION .');
    expect(bootstrapCandidate).toContain('--channel bootstrap');
    expect(publisher).toContain('tools/release/generate-package-readmes.mjs');
    expect(publisher).toContain('--channel stable');
    expect(publisher).toContain('cmp "$EXPECTED_READMES/$README"');
    expect(publisher.indexOf('tools/release/generate-package-readmes.mjs')).toBeLessThan(
      publisher.indexOf('npm publish'),
    );
  });

  it('serializes every state mutation under one per-SHA mutex and every publisher under one alias mutex', () => {
    expect(workflow('release-intent.yml').jobs?.['record-intent']?.concurrency).toEqual({
      group: `release-state-\${{ github.repository }}-\${{ github.sha }}`,
      'cancel-in-progress': false,
      queue: 'max',
    });
    const release = workflow('release.yml');
    for (const jobName of ['build-candidate', 'stage-release']) {
      expect(release.jobs?.[jobName]?.concurrency).toEqual({
        group: `release-state-\${{ github.repository }}-\${{ needs.authorize.outputs.sha }}`,
        'cancel-in-progress': false,
        queue: 'max',
      });
    }
    const publisher = workflow('npm-publish.yml');
    expect(publisher.concurrency).toEqual({
      group: `release-aliases-\${{ github.repository }}`,
      'cancel-in-progress': false,
      queue: 'max',
    });
    expect(publisher.jobs?.publish?.concurrency).toEqual({
      group: `release-state-\${{ github.repository }}-\${{ github.sha }}`,
      'cancel-in-progress': false,
      queue: 'max',
    });
    for (const jobName of ['advance-aliases', 'record-verification', 'rollback-aliases']) {
      expect(publisher.jobs?.[jobName]?.concurrency).toEqual({
        group: `release-state-\${{ github.repository }}-\${{ needs.publish.outputs.sha }}`,
        'cancel-in-progress': false,
        queue: 'max',
      });
    }
    expect(publisher.jobs?.['advance-aliases']?.concurrency?.group).not.toContain(
      'release-aliases',
    );
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
    expect(stage).toContain('ACTUAL_RELEASE_ASSET_COUNT');
    expect(stage.indexOf('ACTUAL_RELEASE_ASSET_COUNT')).toBeLessThan(stage.indexOf('staged-draft'));

    expect(source('release.yml')).not.toContain('npm publish');
    const publish = jobSource('npm-publish.yml', 'publish');
    expect(publish).toContain('gh release download');
    expect(publish).toContain('release-manifest.json');
    expect(publish).toContain('verify-publish-anchors');
    expect(publish).toContain('ACTUAL_RELEASE_ASSET_COUNT');
    expect(publish.indexOf('ACTUAL_RELEASE_ASSET_COUNT')).toBeLessThan(
      publish.indexOf('npm publish'),
    );
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
    expect(run).not.toContain('payload:.npmVerified');
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
      'alias-planned',
      'aliases-verified',
      'final-planned',
      'consumed',
    ]) {
      expect(release).toContain(state);
    }
    expect(release).toContain('recovery-decision');
    expect(release).toContain('compare-and-update');
    expect(jobSource('release.yml', 'authorize')).toContain('alias-planned');
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
    expect(finalize).toContain('--latest=false');
    expect(finalize).not.toMatch(/--latest(?:\s|$)/u);
    expect(finalize).toContain('verify-release-snapshot');
    expect(finalize).toContain('verify-published-release');
    expect(finalize.indexOf('verify-release-snapshot')).toBeLessThan(
      finalize.indexOf('gh release edit'),
    );
    expect(finalize.indexOf('gh release edit')).toBeLessThan(
      finalize.indexOf('verify-published-release'),
    );
    expect(finalize.indexOf('verify-published-release')).toBeLessThan(
      finalize.indexOf('apply_alias "$MINOR_ALIAS"'),
    );
    expect(finalize).toContain('alias-planned');
    expect(finalize).toContain('compare-and-update');
    expect(finalize.indexOf('alias-planned')).toBeLessThan(finalize.indexOf('git push origin'));
    expect(finalize).not.toContain("':refs/tags/v0.1'");
    expect(publisher.jobs?.publish?.concurrency).toBeDefined();
    expect(workflow('npm-publish.yml').concurrency?.group).toBe(
      `release-aliases-\${{ github.repository }}`,
    );
    expect(finalize).toContain('semver-monotonic');
    expect(finalize).toContain('merge-base --is-ancestor');
    expect(finalize.indexOf('semver-monotonic')).toBeLessThan(finalize.indexOf('gh release edit'));
    expect(finalize.indexOf('preflight_alias "$MAJOR_ALIAS"')).toBeLessThan(
      finalize.indexOf('gh release edit'),
    );

    const rollback = publisher.jobs?.['rollback-aliases'];
    expect(rollback?.needs).toEqual(['publish', 'advance-aliases', 'record-verification']);
    expect(rollback?.if).toContain('always()');
    const rollbackRun = jobSource('npm-publish.yml', 'rollback-aliases');
    expect(rollbackRun).toContain('.aliasPlan.aliases | reverse[]');
    expect(rollbackRun).toContain('alias-rollback');
    expect(rollbackRun).toContain('--force-with-lease');
    expect(rollbackRun).toContain('git push origin ":refs/tags/$NAME"');
  });

  it('uses the observed Release draft value and bounded exact-version registry retrieval', () => {
    const publish = jobSource('npm-publish.yml', 'publish');
    expect(publish).toContain('--argjson releaseDraft');
    expect(publish).toContain('draft:$releaseDraft');
    expect(publish).not.toContain('draft:true');
    expect(publish).toContain('then tostring else error("draft is not boolean") end');
    expect(publish).not.toContain('jq -er \'.draft | if type == "boolean" then .');
    expect(publish).toContain('fetch-npm-artifact.mjs probe');
    expect(publish).toContain('fetch-npm-artifact.mjs fetch');
    expect(publish).toContain('--attempts 12');
    expect(publish).toContain('--base-delay-ms 5000');
    expect(publish).toContain('--max-delay-ms 30000');
    expect(publish).toContain('--request-timeout-ms 15000');
    expect(publish).not.toContain('npm view');
    expect(publish).not.toContain('2>/dev/null || true');
    expect(publish.indexOf('fetch-npm-artifact.mjs fetch')).toBeLessThan(
      publish.indexOf('verify-package-integrity.mjs'),
    );

    const aliases = jobSource('npm-publish.yml', 'advance-aliases');
    expect(aliases).toContain('then tostring else error("draft is not boolean") end');
    expect(aliases).not.toContain("jq -er '.draft'");
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

  it('write-ahead logs final evidence and deletes an unconsumed exact upload before alias rollback', () => {
    const record = jobSource('npm-publish.yml', 'record-verification');
    const finalPlanPatch = record.indexOf('approved-final-planned-state.json');
    const upload = record.indexOf('gh release upload');
    const consumedPatch = record.indexOf('approved-consumed-state.json');

    expect(finalPlanPatch).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(finalPlanPatch);
    expect(consumedPatch).toBeGreaterThan(upload);
    expect(record).toContain('final-planned');
    expect(record).toContain('final-idempotency');
    expect(record.match(/alias_target "\$MINOR_ALIAS"/gu)).toHaveLength(2);
    expect(record.match(/alias_target "\$MAJOR_ALIAS"/gu)).toHaveLength(2);
    expect(record.indexOf('verify-published-release')).toBeLessThan(
      record.indexOf('approved-consumed-state.json'),
    );
    expect(record.lastIndexOf('alias_target "$MAJOR_ALIAS"')).toBeLessThan(
      record.indexOf('approved-consumed-state.json'),
    );
    expect(record.indexOf('approved-consumed-state.json')).toBeLessThan(
      record.indexOf('gh release edit "$TAG" --repo "$REPOSITORY" --latest'),
    );
    expect(record.indexOf('latest-promotion')).toBeLessThan(
      record.indexOf('gh release edit "$TAG" --repo "$REPOSITORY" --latest'),
    );

    const rollback = jobSource('npm-publish.yml', 'rollback-aliases');
    const finalDelete = rollback.indexOf('releases/assets/$FINAL_ASSET_ID');
    const aliasRollback = rollback.indexOf('.aliasPlan.aliases | reverse[]');
    const releaseIdentity = rollback.indexOf('ROLLBACK_RELEASE_ID');
    const immutableTagIdentity = rollback.indexOf('rollback-tag-ref.json');
    expect(rollback).toContain('.finalPlanned.finalVerificationDigest');
    expect(finalDelete).toBeGreaterThanOrEqual(0);
    expect(releaseIdentity).toBeGreaterThanOrEqual(0);
    expect(immutableTagIdentity).toBeGreaterThanOrEqual(0);
    expect(releaseIdentity).toBeLessThan(finalDelete);
    expect(immutableTagIdentity).toBeLessThan(finalDelete);
    expect(aliasRollback).toBeGreaterThan(finalDelete);
    expect(rollback).toContain('sha256:$FINAL_DIGEST');
    expect(rollback).toContain('FINAL_COUNT');
  });
});

describe('one-time npm bootstrap', () => {
  it('isolates candidate preparation, one-time credentials, and public verification', () => {
    const bootstrap = workflow('npm-bootstrap.yml');
    expect(bootstrap.on).toHaveProperty('workflow_dispatch');
    expect(bootstrap.concurrency).toEqual({
      group: `npm-bootstrap-\${{ github.repository }}`,
      'cancel-in-progress': false,
    });

    const prepareJob = bootstrap.jobs?.bootstrap;
    const publishJob = bootstrap.jobs?.publish_bootstrap;
    const verifyJob = bootstrap.jobs?.verify_bootstrap;
    expect(prepareJob?.environment).toBeUndefined();
    expect(publishJob?.environment).toBe('npm-bootstrap');
    expect(verifyJob?.environment).toBeUndefined();
    expect(publishJob?.needs).toEqual(['bootstrap']);
    expect(verifyJob?.needs).toEqual(['bootstrap', 'publish_bootstrap']);
    expect(verifyJob?.if).toContain("needs.bootstrap.outputs.needs-publish != 'true'");
    expect(verifyJob?.if).toContain("needs.publish_bootstrap.result == 'success'");

    const prepare = jobSource('npm-bootstrap.yml', 'bootstrap');
    const publish = jobSource('npm-bootstrap.yml', 'publish_bootstrap');
    const verify = jobSource('npm-bootstrap.yml', 'verify_bootstrap');
    const allRun = [prepare, publish, verify].join('\n');
    const prepareSteps = prepareJob?.steps ?? [];
    const publishSteps = publishJob?.steps ?? [];
    const verifySteps = verifyJob?.steps ?? [];
    const allSteps = [...prepareSteps, ...publishSteps, ...verifySteps];

    const validation = prepareSteps.find(
      (step) => step.name === 'Validate the approved request and exact successful CI run',
    )?.run;
    const recovery = prepareSteps.find(
      (step) => step.name === 'Recover the single crash-stable pre-publish anchor',
    )?.run;
    const build = prepareSteps.find(
      (step) => step.name === 'Version first, then build and pack the bootstrap prerelease once',
    )?.run;
    const candidateGateStep = prepareSteps.find(
      (step) => step.name === 'Gate the exact candidate against the public registry',
    );
    const handoffStep = prepareSteps.find(
      (step) => step.name === 'Hand the verified candidate to a fresh publisher runner',
    );
    const freshPreflightStep = publishSteps.find(
      (step) =>
        step.name === 'Revalidate current main, handoff bytes, package name, and public owner',
    );
    const credentialStep = publishSteps.find(
      (step) => step.name === 'Publish the bootstrap candidate with the one-time credential',
    );
    const publicStateStep = verifySteps.find(
      (step) => step.name === 'Verify exact public bootstrap registry state',
    );
    const registryVerification = verifySteps.find(
      (step) => step.name === 'Verify registry bytes, canonical tree, CLI, schemas, and Action',
    )?.run;
    const candidateGate = candidateGateStep?.run;
    const freshPreflight = freshPreflightStep?.run;
    const credentialPublication = credentialStep?.run;
    const publicState = publicStateStep?.run;

    expect(validation).toBeDefined();
    expect(recovery).toBeDefined();
    expect(build).toBeDefined();
    expect(candidateGate).toBeDefined();
    expect(freshPreflight).toBeDefined();
    expect(credentialPublication).toBeDefined();
    expect(publicState).toBeDefined();
    expect(registryVerification).toBeDefined();
    expect(handoffStep?.uses).toBe(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    );
    expect(handoffStep?.with?.name).toBe(`npm-bootstrap-handoff-\${{ github.run_id }}`);

    expect(source('npm-bootstrap.yml')).toContain('default: 0.0.0-bootstrap.0');
    expect(publish).toContain('--tag bootstrap');
    expect(allRun).not.toContain('npm dist-tag ls');
    expect(allRun).not.toContain('npm owner ls');
    expect(verify).toContain('npm view scriptspect dist-tags --json');
    expect(verify).toContain('npm view scriptspect maintainers --json');
    expect(verify).toContain('verify-npm-bootstrap-state.mjs');
    expect(source('npm-bootstrap.yml')).toContain('registry-url: https://registry.npmjs.org');
    expect(prepare).toContain('npm version "$VERSION"');
    expect(prepare).toContain('pnpm build');
    expect(prepare).toContain('pnpm exec vitest run');
    expect(prepare.indexOf('npm version "$VERSION"')).toBeLessThan(prepare.indexOf('pnpm build'));
    expect(prepare.indexOf('pnpm build')).toBeLessThan(prepare.indexOf('pnpm exec vitest run'));
    expect(build?.match(/pnpm build/gu)).toHaveLength(2);
    expect(build).toContain('bootstrap-first-build');
    expect(build).toContain('diff -qr "$RUNNER_TEMP/bootstrap-first-build/dist" dist');
    expect(candidateGateStep?.id).toBe('registry');
    expect(prepare).toContain('needs-publish');
    expect(allRun).toContain('node_modules/scriptspect/dist/cli.mjs');
    expect(allRun).toContain('node_modules/scriptspect/schema/config.schema.json');
    expect(allRun).toContain('node_modules/scriptspect/dist/action.mjs');
    expect(verify).toContain('canonical-tree');
    expect(verify).toContain('comparatorAlgorithmDigest');
    expect(verify).toContain('canonical-tree.mjs algorithm-digest');
    expect(verify).toContain('comparator-source-bundle.json');
    expect(source('npm-bootstrap.yml')).toContain(
      `\${{ runner.temp }}/bootstrap/comparator-source-bundle.json`,
    );
    expect(prepare).toContain('bootstrap-anchor.json');
    expect(prepare).toContain('dist-tags-before.json');
    expect(prepare).toContain('actions/artifacts');
    expect(prepare).toContain('published bootstrap version exists without the retained anchor');
    expect(validation).toContain('git fetch --no-tags origin main');
    expect(validation).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(validation).toContain('.path == ".github/workflows/ci.yml"');
    expect(validation).toContain('.head_repository.full_name == $repository');
    expect(validation).toContain('.conclusion == "success"');
    expect(validation?.indexOf('git merge-base --is-ancestor')).toBeLessThan(
      validation?.indexOf('node tools/release/release-state.mjs') ?? -1,
    );
    expect(validation?.indexOf('.conclusion == "success"')).toBeLessThan(
      validation?.indexOf('node tools/release/release-state.mjs') ?? -1,
    );

    const secretBearingSteps = allSteps.filter((step) =>
      Object.values(step.env ?? {}).some((value) => value.includes('secrets.NPM_BOOTSTRAP_TOKEN')),
    );
    expect(secretBearingSteps).toHaveLength(1);
    expect(prepareSteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(publishSteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(verifySteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(prepare).not.toContain('NPM_BOOTSTRAP_TOKEN');
    expect(secretBearingSteps[0]).toBe(credentialStep);
    expect(freshPreflightStep?.env?.EXPECTED_NPM_OWNER).toBe('Tom409114');
    expect(credentialStep?.env?.EXPECTED_NPM_OWNER).toBe('Tom409114');
    expect(credentialStep?.if).toContain("steps.fresh-registry.outputs.publish-now == 'true'");
    expect(freshPreflight).not.toMatch(/\bnode\s+tools\//u);
    expect(freshPreflight).not.toContain('pnpm ');
    expect(credentialPublication).toContain(`[[ "\${OWNER,,}" == "\${EXPECTED_NPM_OWNER,,}" ]]`);
    expect(credentialPublication?.indexOf(`[[ "\${OWNER,,}"`)).toBeLessThan(
      credentialPublication?.indexOf('npm publish') ?? -1,
    );
    expect(credentialPublication).not.toMatch(/\bnode\s+tools\//u);
    expect(credentialPublication).not.toContain('pnpm ');
    expect(credentialStep?.env?.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
    expect(credentialStep?.env?.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org');
    expect(credentialPublication).toContain('cd "$RUNNER_TEMP/npm-bootstrap-credential"');
    expect(freshPreflight).toContain('unique == [$expected]');
    expect(credentialPublication).toContain('unique == [$expected]');
    expect(credentialPublication).toContain('repos/$REPOSITORY/git/ref/heads/main');
    expect(credentialPublication).toContain('.object.sha == $source and .object.sha == $workflow');
    expect(credentialPublication).toContain('raced-version.json');
    expect(credentialPublication?.indexOf('publish-main.json')).toBeLessThan(
      credentialPublication?.indexOf('npm whoami') ?? -1,
    );
    expect(credentialPublication?.indexOf('publish-main.json')).toBeLessThan(
      credentialPublication?.indexOf('npm publish') ?? -1,
    );
    expect(recovery).toContain('verify-npm-bootstrap-anchor.mjs provenance');
    expect(recovery).toContain('verify-npm-bootstrap-anchor.mjs files');
    expect(recovery).toContain('workflow_run.id');
    expect(recovery).toContain('actions/workflows/npm-bootstrap.yml');
    expect(recovery).toContain('.artifactDigest');
    expect(recovery).toContain('sha256sum "$RUNNER_TEMP/bootstrap-anchor.zip"');
    expect(recovery?.indexOf('bootstrap-anchor.zip')).toBeLessThan(
      recovery?.indexOf('unzip -q') ?? -1,
    );
    expect(build).not.toContain('$RUNNER_TEMP/bootstrap/dist-tags-before.err');
    expect(candidateGate).toContain('git fetch --no-tags origin main');
    expect(candidateGate).toContain('[[ "$(git rev-parse origin/main)" == "$SOURCE_SHA" ]]');
    const existingVersionProbe = candidateGate?.indexOf('existing-version.raw.json') ?? -1;
    const exactMainCheck = candidateGate?.indexOf('git rev-parse origin/main') ?? -1;
    expect(existingVersionProbe).toBeGreaterThanOrEqual(0);
    expect(existingVersionProbe).toBeLessThan(exactMainCheck);
    expect(publicState).toContain('verify-npm-bootstrap-state.mjs');
    expect(publicStateStep?.env ?? {}).not.toHaveProperty('NODE_AUTH_TOKEN');
    expect(
      allRun.match(/verify-npm-bootstrap-state\.mjs normalize/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(registryVerification).toContain('registry-metadata.raw.json');
    expect(allRun).toContain('sha256sum --check SHA256SUMS');
    expect(allRun).toContain('.name == "scriptspect" and .version == $version');
    expect(verify).toContain('canonical-tree.mjs digest --tarball');
    expect(prepare).toMatch(/sha256sum "\$TARBALL_BASENAME" > SHA256SUMS/);
    expect(prepare).not.toMatch(/sha256sum "\$TARBALL" > .*SHA256SUMS/);
    expect(publish).not.toMatch(/npm publish[^\n]*0\.1\.0/);
    expect(source('release.yml')).not.toContain('NPM_BOOTSTRAP_TOKEN');
  });
});
