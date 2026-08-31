import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = join(root, 'tools', 'release', 'prepare-publisher-dispatch.mjs');
const commit = '1'.repeat(40);
const temporaryDirectories: string[] = [];

type Step = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean | number>;
};

type Job = {
  needs?: string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  'timeout-minutes'?: number;
};

type Workflow = {
  jobs?: Record<string, Job>;
};

type HelperInvocation = {
  state?: Record<string, unknown>;
  intentCheck?: Record<string, unknown>;
  tagRef?: Record<string, unknown>;
  intentId?: string;
  sha?: string;
  tag?: string;
  releaseId?: string;
  output?: boolean;
};

function releaseWorkflow(): Workflow {
  return parse(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')) as Workflow;
}

function stagedState(): Record<string, unknown> {
  return {
    schemaVersion: 'scriptspect-release-state/v1',
    revision: 2,
    state: 'staged-draft',
    intent: {
      schemaVersion: 'scriptspect-release-intent/v1',
      intentId: `scriptspect-release-intent:62:${commit}`,
      prNumber: 62,
      mergeCommitSha: commit,
      version: '0.1.0',
      tag: 'v0.1.0',
      packageManifestHash: '2'.repeat(64),
      changelogHash: '3'.repeat(64),
      releasePleaseManifestHash: '4'.repeat(64),
      releasePrActor: 'release-please[bot]',
      releasePrHead: 'release-please--branches--main--components--scriptspect',
      releasePrHeadRepo: 'Tom409114/scriptspect',
      releasePrHeadSha: '5'.repeat(40),
    },
    retainedCandidate: {
      runId: 7101,
      artifactId: 7201,
      artifactDigest: '6'.repeat(64),
      candidateManifestDigest: '7'.repeat(64),
      npmSRI: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
    },
    stagedDraft: {
      releaseId: 7301,
      assets: [
        { name: 'scriptspect-0.1.0.tgz', assetId: 7401, sha256: '9'.repeat(64) },
        { name: 'SHA256SUMS', assetId: 7402, sha256: 'a'.repeat(64) },
        { name: 'candidate-manifest.json', assetId: 7403, sha256: 'b'.repeat(64) },
        { name: 'release-manifest.json', assetId: 7404, sha256: 'c'.repeat(64) },
      ],
      releaseManifestDigest: 'c'.repeat(64),
    },
  };
}

function tagReference(sha = commit, tag = 'v0.1.0'): Record<string, unknown> {
  return {
    ref: `refs/tags/${tag}`,
    node_id: 'REF_node',
    url: `https://api.github.test/repos/Tom409114/scriptspect/git/refs/tags/${tag}`,
    object: {
      type: 'commit',
      sha,
      url: `https://api.github.test/repos/Tom409114/scriptspect/git/commits/${sha}`,
    },
  };
}

function intentCheck(state = stagedState()): Record<string, unknown> {
  return {
    id: 7001,
    name: 'release-intent',
    status: 'completed',
    conclusion: 'success',
    head_sha: commit,
    external_id: `scriptspect-release-intent:62:${commit}`,
    app: { slug: 'github-actions' },
    output: { text: JSON.stringify(state) },
  };
}

function invokeHelper(invocation: HelperInvocation = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-publisher-dispatch-'));
  temporaryDirectories.push(directory);
  const intentCheckPath = join(directory, 'intent-check.json');
  const tagRefPath = join(directory, 'tag-ref.json');
  const outputPath = join(directory, 'dispatch.json');
  writeFileSync(
    intentCheckPath,
    `${JSON.stringify(invocation.intentCheck ?? intentCheck(invocation.state ?? stagedState()))}\n`,
  );
  writeFileSync(tagRefPath, `${JSON.stringify(invocation.tagRef ?? tagReference())}\n`);
  const arguments_ = [
    helper,
    '--intent-check',
    intentCheckPath,
    '--tag-ref',
    tagRefPath,
    '--intent-id',
    invocation.intentId ?? '7001',
    '--sha',
    invocation.sha ?? commit,
    '--tag',
    invocation.tag ?? 'v0.1.0',
    '--release-id',
    invocation.releaseId ?? '7301',
  ];
  if (invocation.output) arguments_.push('--out', outputPath);
  return {
    result: spawnSync(process.execPath, arguments_, { encoding: 'utf8' }),
    outputPath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('publisher dispatch helper', () => {
  it('emits the exact immutable-tag workflow_dispatch ref and inputs', () => {
    const { result, outputPath } = invokeHelper({ output: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const expected = {
      ref: 'v0.1.0',
      inputs: {
        'intent-id': '7001',
        tag: 'v0.1.0',
        sha: '1111111111111111111111111111111111111111',
      },
    };
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(expected);
  });

  it('rejects a release state that has not durably reached staged-draft', () => {
    const state = stagedState();
    state.state = 'retained-candidate';
    state.revision = 1;
    delete state.stagedDraft;

    const { result } = invokeHelper({ state });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/staged-draft/i);
  });

  it('rejects dispatch unless all four immutable Release assets are durably anchored', () => {
    const state = stagedState();
    const stagedDraft = state.stagedDraft as { assets: unknown[] };
    stagedDraft.assets = stagedDraft.assets.filter(
      (asset) => (asset as { name: string }).name !== 'release-manifest.json',
    );

    const { result } = invokeHelper({ state });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exact .*asset set/i);
  });

  it('resumes the exact publisher from a durably persisted alias plan', () => {
    const state = stagedState();
    state.revision = 5;
    state.state = 'alias-planned';
    state.npmPublished = {
      publishedVersion: '0.1.0',
      npmSRI: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
      publishRunId: 7501,
    };
    state.npmVerified = {
      registryNpmSRI: `sha512-${Buffer.alloc(64, 10).toString('base64')}`,
      registryManifestDigest: 'd'.repeat(64),
      provenanceDigest: 'e'.repeat(64),
    };
    state.aliasPlan = {
      version: '0.1.0',
      commit,
      aliases: [
        { name: 'v0.1', previousTarget: null, target: commit },
        { name: 'v0', previousTarget: 'f'.repeat(40), target: commit },
      ],
    };

    const { result } = invokeHelper({ state });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ref: 'v0.1.0' });
  });

  it('rejects a check-run that is not a successful GitHub Actions release intent', () => {
    const check = intentCheck();
    check.conclusion = 'failure';

    const { result } = invokeHelper({ intentCheck: check });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/intent check conclusion.*conflict/i);
  });

  it('rejects durable intent state that is not bound to the check-run external ID', () => {
    const state = stagedState();
    const intent = state.intent as Record<string, unknown>;
    intent.intentId = `scriptspect-release-intent:63:${commit}`;

    const { result } = invokeHelper({ state });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/intent check externalId.*conflict/i);
  });

  it.each([
    {
      name: 'check-run ID',
      invocation: { intentId: '7002' },
      message: /intent check id.*conflict/i,
    },
    {
      name: 'tag',
      invocation: { tag: 'v0.2.0', tagRef: tagReference(commit, 'v0.2.0') },
      message: /tag.*conflict/i,
    },
    {
      name: 'commit SHA',
      invocation: { sha: 'd'.repeat(40), tagRef: tagReference('d'.repeat(40)) },
      message: /intent check head sha.*conflict/i,
    },
    {
      name: 'release ID',
      invocation: { releaseId: '7302' },
      message: /releaseId.*conflict/i,
    },
  ])('rejects an expected $name that does not match durable state', ({ invocation, message }) => {
    const { result } = invokeHelper(invocation);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it('rejects a tag ref whose target does not match the authorized commit SHA', () => {
    const { result } = invokeHelper({ tagRef: tagReference('e'.repeat(40)) });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/tag ref.*sha.*conflict/i);
  });
});

describe('release publisher dispatch workflow', () => {
  it('runs the validator after fetching durable state and tag ref, then posts its payload', () => {
    const dispatch = releaseWorkflow().jobs?.['dispatch-publisher'];

    expect(dispatch).toBeDefined();
    expect(dispatch?.needs).toEqual(['authorize', 'stage-release']);
    expect(dispatch?.if).toBe("needs.stage-release.result == 'success'");
    expect(dispatch?.environment).toBe('release');
    expect(dispatch?.['timeout-minutes']).toBeGreaterThan(0);
    expect(dispatch?.permissions).toEqual({
      actions: 'write',
      checks: 'read',
      contents: 'read',
    });

    expect(dispatch?.steps?.[0]).toEqual({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: `\${{ needs.authorize.outputs.sha }}`,
        'persist-credentials': false,
      },
    });

    const step = dispatch?.steps?.find(
      (candidate) => candidate.name === 'Dispatch exact publisher',
    );
    expect(step?.env).toEqual({
      GH_TOKEN: `\${{ github.token }}`,
      REPOSITORY: `\${{ github.repository }}`,
      INTENT_ID: `\${{ needs.authorize.outputs.intent-id }}`,
      SHA: `\${{ needs.authorize.outputs.sha }}`,
      TAG: `\${{ needs.authorize.outputs.tag }}`,
      RELEASE_ID: `\${{ needs.stage-release.outputs.release-id }}`,
    });

    const run = step?.run ?? '';
    const stateFetch = run.indexOf('repos/$REPOSITORY/check-runs/$INTENT_ID');
    const tagFetch = run.indexOf('git/ref/tags/$TAG');
    const validation = run.indexOf('tools/release/prepare-publisher-dispatch.mjs');
    const dispatchCall = run.indexOf('actions/workflows/npm-publish.yml/dispatches');

    expect(stateFetch).toBeGreaterThanOrEqual(0);
    expect(tagFetch).toBeGreaterThan(stateFetch);
    expect(validation).toBeGreaterThan(tagFetch);
    expect(dispatchCall).toBeGreaterThan(validation);
    expect(run).not.toContain('.state | IN(');
    expect(run).not.toContain('jq -n --arg ref');
  });
});
