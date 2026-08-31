import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function runCorpusSelection(requested: number, candidates: string[]) {
  const selectionStep = allSteps(workflow('corpus.yml')).find(
    (step) => step.name === 'Select the exact deterministic repository sample',
  );
  const match = selectionStep?.run?.match(
    /node --input-type=module <<'NODE'\n(?<program>[\s\S]+?)\nNODE/u,
  );
  if (!match?.groups?.program) {
    throw new Error('corpus selection step must expose an executable inline Node program');
  }

  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-corpus-selection-'));
  const candidateFile = join(directory, 'candidates.txt');
  const selectedFile = join(directory, 'selected.txt');
  const selectionFile = join(directory, 'selection.json');
  try {
    writeFileSync(candidateFile, `${candidates.join('\n')}\n`, 'utf8');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', match.groups.program],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          REPO_COUNT: String(requested),
          CANDIDATE_FILE: candidateFile,
          SELECTED_FILE: selectedFile,
          SELECTION_FILE: selectionFile,
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(`corpus selection failed:\n${result.stderr}`);
    }
    return {
      repositories: readFileSync(selectedFile, 'utf8').trimEnd().split('\n'),
      selection: JSON.parse(readFileSync(selectionFile, 'utf8')) as unknown,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    for (const name of workflowNames()) {
      expect(workflowSource(name)).not.toContain('pull_request_target:');
    }
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
    expect(generatedRun).toContain('check-readme-parity.ts');
    expect(generatedRun).not.toContain('generate-readme-status.ts');
    expect(generatedRun).toContain('docs/readme-status.json');
    expect(generatedRun).toContain('git cat-file -e');
    expect(generatedRun).toContain('git merge-base --is-ancestor');
    expect(generatedRun).toContain('git diff --exit-code');

    const generatedCheckout = (ci.jobs?.generated?.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(generatedCheckout?.with?.['fetch-depth']).toBe(0);

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

  it('bounds every hosted job and caps GitHub Search pages at 100', () => {
    for (const name of workflowNames()) {
      for (const [jobName, job] of Object.entries(workflow(name).jobs ?? {})) {
        expect(job['timeout-minutes'], `${name}:${jobName}`).toBeGreaterThan(0);
      }
    }
    const corpus = workflowSource('corpus.yml');
    expect(corpus).toContain('REPO_COUNT" -le 100');
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
  it('selects exactly one repository and records requested and actual counts', () => {
    const result = runCorpusSelection(1, ['zeta/project', 'alpha/project']);

    expect(result.repositories).toEqual(['alpha/project']);
    expect(result.selection).toEqual({ schemaVersion: 1, requested: 1, actual: 1 });
  });

  it('selects exactly 100 repositories at the supported upper bound', () => {
    const candidates = Array.from(
      { length: 120 },
      (_, index) => `owner/project-${String(119 - index).padStart(3, '0')}`,
    );
    const result = runCorpusSelection(100, candidates);

    expect(result.repositories).toHaveLength(100);
    expect(result.repositories[0]).toBe('owner/project-000');
    expect(result.repositories[99]).toBe('owner/project-099');
    expect(result.selection).toEqual({ schemaVersion: 1, requested: 100, actual: 100 });
  });

  it('deduplicates overlapping search results before applying the exact limit', () => {
    const result = runCorpusSelection(3, [
      'owner/project-c',
      'owner/project-a',
      'owner/project-b',
      'owner/project-a',
      'owner/project-c',
      'owner/project-d',
    ]);

    expect(result.repositories).toEqual(['owner/project-a', 'owner/project-b', 'owner/project-c']);
    expect(result.selection).toEqual({ schemaVersion: 1, requested: 3, actual: 3 });
  });
});
