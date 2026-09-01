import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

describe('published homepage handoff', () => {
  it('creates the receipt only after the consumed release state is durable', () => {
    const workflow = parse(read('.github/workflows/npm-publish.yml')) as {
      jobs?: Record<string, { steps?: Step[] }>;
    };
    const steps = workflow.jobs?.['record-verification']?.steps ?? [];
    const recorder = steps.find((step) => step.name?.includes('idempotent final evidence'));
    const upload = steps.find((step) => step.name === 'Upload the terminal README handoff receipt');
    const run = recorder?.run ?? '';

    const consumedState = run.indexOf('approved-consumed-state.json');
    const consumedPatch = run.indexOf('summary:"Final verification is exact and idempotent"');
    const receipt = run.indexOf('scriptspect-readme-release-receipt/v1');
    expect(consumedState).toBeGreaterThanOrEqual(0);
    expect(consumedPatch).toBeGreaterThan(consumedState);
    expect(receipt).toBeGreaterThan(consumedPatch);
    expect(run).toContain('--argjson intentCheckRunId "$INTENT_ID"');
    expect(run).toContain('--argjson finalVerificationAssetId "$FINAL_ASSET_ID"');
    expect(run).toContain("'.npmPublished.publishRunId'");
    expect(run).toContain('--slurpfile finalVerification');

    expect(steps.indexOf(upload as Step)).toBeGreaterThan(steps.indexOf(recorder as Step));
    expect(upload?.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload?.with).toMatchObject({
      name: `readme-release-receipt-v\${{ needs.publish.outputs.version }}`,
      path: `\${{ runner.temp }}/readme-release-receipt.json`,
      'if-no-files-found': 'error',
    });
  });

  it('documents and enforces the separate evidence-backed README PR', () => {
    const generator = read('tools/generate-readme-status.ts');
    const runbook = read('docs/release-readme.md');
    const ci = read('.github/workflows/ci.yml');

    expect(generator).toContain('published README state requires --receipt terminal evidence');
    expect(generator).toContain('validateReceiptAgainstStatus');
    expect(runbook).toContain('The transition is deliberately a second pull request');
    expect(runbook).toContain('--published');
    expect(runbook).toContain('--receipt');
    expect(runbook).toContain('Update `SECURITY.md`');
    expect(runbook).toContain('Keep the post-release artifact policy in');
    expect(runbook).toContain('VERSION=0.1.0');
    expect(runbook).toContain('RELEASE_COMMIT="$(git rev-parse');
    expect(runbook).toContain('export GITHUB_TOKEN="$(gh auth token)"');
    expect(runbook).not.toMatch(/<(?:RELEASE_COMMIT|VERSION|read-only-token)>/u);
    expect(runbook).toContain('verify-readme-release-evidence.ts');
    expect(ci).toContain('pnpm exec tsx tools/verify-readme-release-evidence.ts');
  });
});
