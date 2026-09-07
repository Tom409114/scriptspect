import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));

it('keeps recovery downstream jobs eligible after discovery is intentionally skipped', () => {
  for (const jobName of ['build-candidate', 'stage-release', 'dispatch-publisher']) {
    const job = workflow.jobs[jobName];
    // A status function disables Actions implicit success() across skipped ancestors.
    expect(job.if, jobName).toMatch(/always\(\)/);
    for (const dependency of job.needs) {
      expect(job.if, `${jobName} must still fail closed on ${dependency}`).toContain(
        `needs.${dependency}.result == 'success'`,
      );
    }
  }
});
