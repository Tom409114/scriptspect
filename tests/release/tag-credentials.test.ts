import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('uses the release-scoped deploy key for both protected tag writers', () => {
  for (const [file, jobName] of [
    ['release.yml', 'stage-release'],
    ['npm-publish.yml', 'advance-aliases'],
  ]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'));
    const job = workflow.jobs[jobName];
    expect(job.environment).toBe('release');
    const checkout = job.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
    expect(checkout.with['ssh-key']).toBe('${{ secrets.RELEASE_TAG_DEPLOY_KEY }}');
    expect(checkout.with['persist-credentials']).not.toBe(false);
  }
});
