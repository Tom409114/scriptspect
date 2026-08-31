import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runComparison } from '../../tools/comparison/run';

const outputs: string[] = [];

afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

describe('pinned shared-corpus comparison harness', () => {
  it('pins the competitor package and integrity in both policy and lockfile', () => {
    const toolchain = JSON.parse(readFileSync('comparison/toolchain.json', 'utf8')) as {
      scriptsDoctor: { version: string; integrity: string };
    };
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const lock = readFileSync('pnpm-lock.yaml', 'utf8');

    expect(pkg.devDependencies['scripts-doctor']).toBe(toolchain.scriptsDoctor.version);
    expect(lock).toContain(`scripts-doctor@${toolchain.scriptsDoctor.version}`);
    expect(lock).toContain(toolchain.scriptsDoctor.integrity);
  });

  it('captures normalized outputs and hashes without mutating the shared fixtures', () => {
    const outputDir = join(mkdtempSync(join(tmpdir(), 'scriptspect-comparison-parent-')), 'run');
    outputs.push(resolve(outputDir, '..'));
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const before = readFileSync('tests/fixtures/comparison/raw-rm/package.json', 'utf8');

    const manifest = runComparison({ outputDir, sourceCommit, enforcePinnedNode: false });

    expect(manifest.fixtures).toHaveLength(7);
    expect(manifest.tools.scriptsDoctor).toMatchObject({ version: '1.0.0' });
    expect(manifest.tools.scriptspect.sourceCommit).toBe(sourceCommit);
    expect(manifest.environment.matchedPinnedNode).toBe(false);
    expect(manifest.promotable).toBe(false);
    expect(Object.keys(manifest.artifactSha256).length).toBeGreaterThan(14);
    expect(readFileSync('tests/fixtures/comparison/raw-rm/package.json', 'utf8')).toBe(before);

    const adjudication = readFileSync(
      join(outputDir, 'comparison-adjudication-draft.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(adjudication).toHaveLength(14);
    expect(adjudication[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'pending',
      rationale: null,
      reviewer: null,
      reviewedAt: null,
    });

    const persisted = readFileSync(join(outputDir, 'comparison-run.json'), 'utf8');
    expect(persisted).not.toContain(resolve('.'));
    expect(persisted).toContain('$REPOSITORY');
    expect(persisted).not.toMatch(/(?:[A-Z]:\\|\/home\/|\/Users\/)/u);
    for (const fixture of manifest.fixtures) {
      expect(fixture.fixtureSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(fixture.scriptspect.exitCode).toBeOneOf([0, 1]);
      expect(fixture.scriptsDoctor.exitCode).toBe(0);
    }
  });
});
