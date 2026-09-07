import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

type Environment = Record<string, string>;
type Workflow = {
  env?: Environment;
  jobs: Record<
    string,
    {
      env?: Environment;
      steps: { name?: string; env?: Environment; run?: string }[];
    }
  >;
};

it('supplies workflow authentication at every release GitHub CLI boundary', () => {
  for (const file of ['release.yml', 'npm-publish.yml', 'npm-bootstrap.yml']) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as Workflow;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        if (!/\bgh (?:api|release|run)\b/.test(step.run ?? '')) continue;
        const environment = { ...workflow.env, ...job.env, ...step.env };
        expect(
          environment.GH_TOKEN || environment.GITHUB_TOKEN,
          `${file}: ${jobName}: ${step.name}`,
        ).toBeTruthy();
      }
    }
  }
});
