import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Step = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
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

function releaseWorkflow(): Workflow {
  return parse(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')) as Workflow;
}

describe('release publisher dispatch', () => {
  it('dispatches the publisher from the immutable tag only after durable staging', () => {
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
    const durableStateCheck = run.indexOf('.state | IN(');
    const tagCheck = run.indexOf('git/ref/tags/$TAG');
    const dispatchCall = run.indexOf('actions/workflows/npm-publish.yml/dispatches');

    expect(run).toContain('repos/$REPOSITORY/check-runs/$INTENT_ID');
    expect(run).toContain(
      '.state | IN("staged-draft","npm-published","npm-verified","aliases-verified","consumed")',
    );
    expect(run).toContain('.intent.intentId == $intentId');
    expect(run).toContain('.intent.mergeCommitSha == $sha');
    expect(run).toContain('.intent.tag == $tag');
    expect(run).toContain('.stagedDraft.releaseId == $releaseId');
    expect(run).toContain('.object.type == "commit" and .object.sha == $sha');
    expect(run).toContain('{ref:$ref,inputs:{"intent-id":$intentId,tag:$tag,sha:$sha}}');
    expect(durableStateCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeGreaterThan(durableStateCheck);
    expect(dispatchCall).toBeGreaterThan(tagCheck);
  });
});
