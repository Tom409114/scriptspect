import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
  if?: string;
};

type Job = {
  permissions?: Record<string, string>;
  steps?: Step[];
  needs?: string | string[];
  'timeout-minutes'?: number;
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
};

function workflow(name: string): Workflow {
  return parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8')) as Workflow;
}

function workflowSource(name: string): string {
  return readFileSync(join(root, '.github', 'workflows', name), 'utf8');
}

function allSteps(config: Workflow): Step[] {
  return Object.values(config.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function workflowNames(): string[] {
  return readdirSync(join(root, '.github', 'workflows'))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

describe('pull-request trust boundary', () => {
  it('keeps contributor-controlled workflows read-only and free of secrets or pushes', () => {
    const pullRequestWorkflows = workflowNames().filter((name) =>
      Object.hasOwn(workflow(name).on ?? {}, 'pull_request'),
    );
    expect(pullRequestWorkflows).toEqual(['ci.yml']);
    for (const name of pullRequestWorkflows) {
      const config = workflow(name);
      expect(config.on).toHaveProperty('pull_request');
      expect(config.permissions).toEqual({ contents: 'read' });

      for (const job of Object.values(config.jobs ?? {})) {
        expect(job.permissions?.contents).not.toBe('write');
      }

      const source = workflowSource(name);
      expect(source).not.toMatch(/git\s+push/);
      expect(source).not.toContain('secrets.');
      expect(source).not.toContain('pull_request_target:');
    }

    const targetWorkflows = workflowNames().filter((name) =>
      Object.hasOwn(workflow(name).on ?? {}, 'pull_request_target'),
    );
    expect(targetWorkflows).toEqual(['release-readiness.yml']);
    const trustedGate = workflow('release-readiness.yml');
    expect(trustedGate.permissions).toEqual({ contents: 'read' });
    const trustedCheckout = allSteps(trustedGate).find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(trustedCheckout).toBeDefined();
    expect(trustedCheckout?.with ?? {}).not.toHaveProperty('ref');
    expect(trustedCheckout?.with).toMatchObject({ 'persist-credentials': false });
    const trustedSource = workflowSource('release-readiness.yml');
    expect(trustedSource).not.toContain('github.event.pull_request.base.sha');
    expect(trustedSource).not.toContain('github.event.pull_request.head.sha');
    expect(trustedSource).not.toContain('github.event.pull_request.head.ref');
    expect(trustedSource).not.toContain('secrets.');
    expect(trustedSource).not.toMatch(/git\s+push/);
    expect(trustedSource).not.toContain('contents: write');
  });

  it('uses immutable third-party Action revisions in every workflow', () => {
    for (const name of workflowNames()) {
      for (const step of allSteps(workflow(name))) {
        if (
          !step.uses ||
          step.uses.startsWith('./') ||
          step.uses === 'Tom409114/scriptspect@v0.1' ||
          step.uses === 'Tom409114/scriptspect@v0'
        ) {
          continue;
        }
        expect(step.uses, `${name}: ${step.uses}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('pins artifact actions to reviewed Node 24 releases', () => {
    const approved: Record<string, string> = {
      'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', // v7.0.1
      'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', // v8.0.1
    };
    const usages: Array<{ action: string; workflow: string; uses: string }> = [];

    for (const name of workflowNames()) {
      for (const step of allSteps(workflow(name))) {
        const action = Object.keys(approved).find((candidate) =>
          step.uses?.startsWith(`${candidate}@`),
        );
        if (action && step.uses) {
          usages.push({ action, workflow: name, uses: step.uses });
        }
      }
    }

    expect(usages.length).toBeGreaterThan(0);
    for (const usage of usages) {
      expect(usage.uses, usage.workflow).toBe(`${usage.action}@${approved[usage.action]}`);
    }
  });
});

describe('reproducible CI', () => {
  it('never mutates dependency resolution and proves the committed lockfile is coherent', () => {
    for (const name of ['ci.yml', 'corpus.yml', 'release.yml', 'npm-bootstrap.yml']) {
      const source = workflowSource(name);
      expect(source).not.toContain('--no-frozen-lockfile');
      expect(source).not.toContain('--lockfile-only');

      for (const step of allSteps(workflow(name))) {
        if (step.run?.includes('pnpm install')) {
          expect(step.run, `${name}: ${step.run}`).toContain('--frozen-lockfile');
        }
      }
    }

    const ci = workflow('ci.yml');
    expect(ci.jobs?.['lockfile-consistency']).toBeDefined();
    expect(
      ci.jobs?.['lockfile-consistency']?.steps?.some((step) =>
        step.run?.includes('git diff --exit-code'),
      ),
    ).toBe(true);
  });

  it('enforces 90 percent coverage and generated-file parity', () => {
    const ci = workflow('ci.yml');
    expect(ci.jobs?.generated?.permissions).toEqual({ checks: 'read', contents: 'read' });
    const qualitySteps = ci.jobs?.quality?.steps ?? [];
    const qualityRun = qualitySteps.map((step) => step.run ?? '').join('\n');
    expect(qualityRun).toContain('--coverage');
    expect(qualityRun).toContain("--coverage.include='src/parser/**'");
    expect(qualityRun).toContain("--coverage.include='src/rules/**'");
    expect(qualityRun).toContain('90');
    expect(qualityRun).toContain('--error-on-warnings');

    const generatedRun = (ci.jobs?.generated?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(generatedRun).toContain('generate-schemas.ts');
    expect(generatedRun).toContain('generate-readme-demo.ts');
    expect(generatedRun).toContain('verify-readme-release-evidence.ts');
    expect(generatedRun).toContain('check-readme-parity.ts');
    expect(generatedRun).not.toContain('generate-readme-status.ts');
    expect(generatedRun).toContain('docs/readme-status.json');
    expect(generatedRun).toContain('git cat-file -e');
    expect(generatedRun).toContain('git merge-base --is-ancestor');
    expect(generatedRun).toContain('SOURCE_BASE');
    expect(generatedRun).toContain('set -o pipefail');
    expect(generatedRun).toContain('SOURCE_DIFF=$?');
    expect(generatedRun).toContain('case "$SOURCE_DIFF" in');
    expect(generatedRun).not.toContain('if ! git diff --quiet "$SOURCE_BASE" HEAD --');
    expect(generatedRun).toContain('git archive "$STATUS_COMMIT"');
    for (const pinnedAsset of [
      'package.before.json',
      'terminal.txt',
      'fix.patch',
      'package.after.json',
    ]) {
      expect(generatedRun).toContain(pinnedAsset);
    }
    expect(generatedRun).not.toContain('terminal.svg');
    expect(generatedRun).toContain('docs/validation/readme-action-evidence.json');
    expect(generatedRun).toContain('git diff --quiet "$STATUS_COMMIT" HEAD --');
    expect(generatedRun).not.toContain('git diff-tree');
    expect(generatedRun).toContain('git diff --exit-code');

    const statusGenerator = readFileSync(join(root, 'tools/generate-readme-status.ts'), 'utf8');
    for (const sourceInput of [
      'src',
      'dist',
      'schema',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'action.yml',
      'tsconfig.json',
      'tsup.config.ts',
    ]) {
      expect(generatedRun).toContain(sourceInput);
      expect(statusGenerator).toContain(`'${sourceInput}'`);
    }

    const generatedCheckout = (ci.jobs?.generated?.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(generatedCheckout?.with?.['fetch-depth']).toBe(0);
    const generatedCommand = (ci.jobs?.generated?.steps ?? []).find((step) =>
      step.run?.includes('verify-readme-release-evidence.ts'),
    );
    expect(generatedCommand?.env?.GITHUB_TOKEN).toBe(`\${{ github.token }}`);

    const paritySource = readFileSync(join(root, 'tools/check-readme-parity.ts'), 'utf8');
    expect(paritySource).not.toContain("execFileSync('git'");
    expect(paritySource).not.toContain("spawnSync('git'");

    const qualityBuildIndex = qualitySteps.findIndex((step) => step.run === 'pnpm build');
    const qualityCoverageIndex = qualitySteps.findIndex((step) => step.run?.includes('--coverage'));
    expect(qualityBuildIndex).toBeGreaterThanOrEqual(0);
    expect(qualityBuildIndex).toBeLessThan(qualityCoverageIndex);

    const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageManifest.scripts?.pretest).toBe('pnpm build');

    const integrationSteps = ci.jobs?.integration?.steps ?? [];
    const integrationTestIndex = integrationSteps.findIndex((step) => step.run === 'pnpm test');
    expect(integrationTestIndex).toBeGreaterThanOrEqual(0);
    expect(
      integrationSteps.slice(integrationTestIndex + 1).some((step) => step.run === 'pnpm build'),
    ).toBe(false);
  });

  it('separates CodeQL and dependency review at minimum permissions', () => {
    const ci = workflow('ci.yml');
    expect(ci.jobs?.codeql?.permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    expect(ci.jobs?.['dependency-review']?.permissions).toEqual({ contents: 'read' });
    expect(
      ci.jobs?.['dependency-review']?.steps?.some((step) =>
        step.uses?.startsWith('actions/dependency-review-action@'),
      ),
    ).toBe(true);
    expect(
      ci.jobs?.codeql?.steps?.some((step) =>
        step.uses?.startsWith('actions/dependency-review-action@'),
      ),
    ).not.toBe(true);
  });

  it('machine-checks the direct runtime dependency budget', () => {
    const ci = workflow('ci.yml');
    const run = (ci.jobs?.['dependency-policy']?.steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(run).toContain('dependencies');
    expect(run).toContain('< 10');
  });

  it('retains hosted evidence for the 100-package performance gate', () => {
    const ci = workflow('ci.yml');
    const benchmark = ci.jobs?.['workspace-benchmark'];
    const run = (benchmark?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('tools/benchmark-workspace.ts');
    expect(run).toContain('workspace-benchmark.json');
    expect(
      benchmark?.steps?.some((step) => step.uses?.startsWith('actions/upload-artifact@')),
    ).toBe(true);
  });

  it('collects hosted Action annotations and summary as dependent evidence', () => {
    const ci = workflow('ci.yml');
    const consumer = ci.jobs?.['action-consumer'];
    const evidence = ci.jobs?.['action-evidence'];
    expect(evidence?.needs).toContain('action-consumer');
    expect(evidence?.permissions).toEqual({ contents: 'read', actions: 'read', checks: 'read' });
    const consumerRun = (consumer?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(consumerRun).toContain('GITHUB_STEP_SUMMARY=');
    expect(consumerRun).toContain('action-summary.md');
    expect(consumerRun).toContain('Scanned **1 script** across **1 package**.');
    expect(consumer?.steps?.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(
      true,
    );
    const run = (evidence?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('/annotations');
    expect(run).toContain('any(.[];');
    expect(run).toContain('gh run download');
    expect(run).toContain('action-summary.md');
    expect(run).not.toContain('.output.summary');
    expect(run).toContain('action-runner-evidence.json');
    expect(evidence?.steps?.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(
      true,
    );
  });

  it('bounds every hosted job and delegates the 100-repository cap to the typed resolver', () => {
    for (const name of workflowNames()) {
      for (const [jobName, job] of Object.entries(workflow(name).jobs ?? {})) {
        expect(job['timeout-minutes'], `${name}:${jobName}`).toBeGreaterThan(0);
      }
    }
    const corpus = workflowSource('corpus.yml');
    expect(corpus).toContain("default: '100'");
    expect(corpus).toContain('tools/corpus-resolve.ts');
    expect(corpus).not.toContain('{0,2}');
  });

  it('consumes the bundled Action through uses ./ against broken and clean fixtures', () => {
    const ci = workflow('ci.yml');
    const steps = ci.jobs?.['action-consumer']?.steps ?? [];
    const localConsumers = steps.filter((step) => step.uses === './');

    expect(localConsumers).toHaveLength(2);
    expect(localConsumers.some((step) => step['continue-on-error'] === true)).toBe(true);
    expect(steps.some((step) => step.if?.includes('always()'))).toBe(true);

    const assertionStep = steps.find((step) => step.if?.includes('always()'));
    expect(assertionStep?.env).toMatchObject({
      BROKEN_OUTCOME: `\${{ steps.broken.outcome }}`,
      BROKEN_EXIT: `\${{ steps.broken.outputs.exit-code }}`,
      CLEAN_EXIT: `\${{ steps.clean.outputs.exit-code }}`,
    });
    const assertions = steps.map((step) => step.run ?? '').join('\n');
    expect(assertions).toContain('BROKEN_OUTCOME');
    expect(assertions).toContain('BROKEN_EXIT');
    expect(assertions).toContain('CLEAN_EXIT');
    expect(assertions).toContain('sha256sum --check');
    expect(assertions).toContain('git diff --exit-code -- dist/action.mjs');
    const fixtureStep = steps.find(
      (step) => step.name === 'Create controlled clean and broken consumers',
    );
    expect(fixtureStep?.run).toContain("node --input-type=module <<'NODE'");
    expect(fixtureStep?.run).not.toMatch(/(?:^|\n)node -e "/u);
    expect(
      execFileSync('git', ['ls-files', '-s', '--', 'dist/action.mjs'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ).toMatch(/^100755 /u);
  });
});

describe('corpus repository selection', () => {
  it('captures the complete ranked candidate universe before resolving the sample', () => {
    const steps = allSteps(workflow('corpus.yml'));
    const collector = steps.find(
      (step) => step.name === 'Collect the ranked repository candidate snapshot',
    );
    const resolver = steps.find(
      (step) => step.name === 'Resolve the exact root-eligible repository sample',
    );

    expect(collector?.run).toBe(
      'pnpm exec tsx tools/corpus-candidates.ts repository-candidates.json',
    );
    expect(collector?.env).toEqual({ GITHUB_TOKEN: `\${{ github.token }}` });
    expect(steps.indexOf(collector as Step)).toBeLessThan(steps.indexOf(resolver as Step));
    expect(workflowSource('corpus.yml')).not.toContain('uniqueCandidates.sort');
    expect(workflowSource('corpus.yml')).not.toContain('gh api');
  });

  it('resolves the exact root-eligible sample before the scanner runs', () => {
    const steps = allSteps(workflow('corpus.yml'));
    const resolver = steps.find(
      (step) => step.name === 'Resolve the exact root-eligible repository sample',
    );
    const scannerIndex = steps.findIndex(
      (step) => step.name === 'Scan scripts without writing to sampled repositories',
    );
    const resolverIndex = steps.indexOf(resolver as Step);

    expect(resolverIndex).toBeGreaterThanOrEqual(0);
    expect(resolverIndex).toBeLessThan(scannerIndex);
    expect(resolver?.run).toBe(
      'pnpm exec tsx tools/corpus-resolve.ts repository-candidates.json repos.txt repository-sample.json "$REPO_COUNT"',
    );
    expect(resolver?.env).toMatchObject({
      GITHUB_TOKEN: `\${{ github.token }}`,
      REPO_COUNT: `\${{ inputs.repo-count || '100' }}`,
    });

    const scanner = steps[scannerIndex];
    expect(scanner?.env).toMatchObject({
      CORPUS_SAMPLE_METHOD: 'popularity-strata-round-robin-v1',
      CORPUS_CANDIDATE_SNAPSHOT: 'repository-candidates.json',
      CORPUS_SAMPLE_EVIDENCE: 'repository-sample.json',
    });
    const upload = steps.find(
      (step) => step.name === 'Upload draft evidence for maintainer review',
    );
    expect(String(upload?.with?.path)).toContain('repository-candidates.json');
  });
});
