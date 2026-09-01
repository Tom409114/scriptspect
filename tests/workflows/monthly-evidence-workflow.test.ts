import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = join(process.cwd(), '.github', 'workflows', 'monthly-evidence.yml');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Workflow = {
  on?: {
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      'timeout-minutes'?: number;
      steps?: Step[];
    }
  >;
};

it('collects a monthly/manual read-only draft and only uploads an artifact', () => {
  expect(existsSync(workflowPath)).toBe(true);
  const source = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';
  const workflow = parse(source) as Workflow;
  expect(workflow.on).toHaveProperty('workflow_dispatch');
  expect(workflow.on?.schedule).toEqual([{ cron: '17 3 1 * *' }]);
  expect(workflow.permissions).toEqual({
    actions: 'read',
    contents: 'read',
    issues: 'read',
  });
  expect(Object.keys(workflow.jobs ?? {})).toEqual(['collect']);

  const job = workflow.jobs?.collect;
  expect(job?.['timeout-minutes']).toBe(10);
  expect(job?.permissions).toBeUndefined();
  const steps = job?.steps ?? [];
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout).toMatchObject({
    uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    with: { 'persist-credentials': false },
  });
  expect(
    steps.some(
      (step) => step.uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    ),
  ).toBe(true);

  const install = steps.find((step) => step.run?.includes('pnpm install'));
  expect(install?.run).toContain('pnpm@11.24.0');
  expect(install?.run).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  expect(install?.env).toBeUndefined();

  const collector = steps.find((step) => step.run?.includes('collect-monthly-evidence.ts'));
  expect(collector?.run).toContain('--repository "$GITHUB_REPOSITORY"');
  expect(collector?.run).toContain('--package scriptspect');
  expect(collector?.run).toContain('--json evidence/monthly-evidence-draft.json');
  expect(collector?.run).toContain('--markdown evidence/monthly-evidence-draft.md');
  expect(collector?.env).toEqual({ GITHUB_TOKEN: `\${{ github.token }}` });

  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload).toMatchObject({
    if: 'always()',
    uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    with: {
      name: `monthly-evidence-draft-\${{ github.run_id }}`,
      path: 'evidence/',
      'if-no-files-found': 'error',
      'retention-days': 30,
    },
  });

  expect(source).not.toContain('secrets.');
  expect(source).not.toContain('contents: write');
  expect(source).not.toMatch(/git\s+(?:commit|push)/u);
  expect(source).not.toContain('pull_request_target');
  expect(source.match(/GITHUB_TOKEN:/gu)).toHaveLength(1);
  for (const step of steps) {
    if (!step.uses || step.uses.startsWith('./')) continue;
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
  }
});
