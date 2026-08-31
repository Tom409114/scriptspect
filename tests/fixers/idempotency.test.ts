import { describe, expect, it } from 'vitest';
import { analyzeScript } from '../../src/rules';
import { applyToScript } from '../../src/fixers/apply';
import { planFixes } from '../../src/fixers/fix-plan';
import type { AnalysisResult, PackageUnit } from '../../src/core/analyze';
import { DEFAULT_TARGETS } from '../../src/core/targets';

function fixOnce(script: string, deps: string[]): string {
  const findings = analyzeScript(script, {
    script,
    scriptName: 'test',
    packagePath: 'package.json',
    targets: DEFAULT_TARGETS,
    dependencies: new Set(deps),
    workspaceBins: new Set(),
  });
  return applyToScript(script, findings).script;
}

describe('fixer idempotency (spec §7.1: applying twice must not double-wrap)', () => {
  const cases: Array<[string, string[], string]> = [
    ['NODE_ENV=production vite build', ['cross-env'], 'cross-env NODE_ENV=production vite build'],
    ['rm -rf dist', ['rimraf'], 'rimraf dist'],
    ['rm -rf dist', ['shx'], 'shx rm -rf dist'],
    ['cp -r src dist', ['shx'], 'shx cp -r src dist'],
    ['mkdir -p dist/assets', ['shx'], 'shx mkdir -p dist/assets'],
    ['A=1 rm -rf b && cp x y', ['rimraf', 'shx'], 'A=1 rimraf b && shx cp x y'],
  ];

  for (const [script, deps, expected] of cases) {
    it(`fix("${script}") twice stays "${expected}"`, () => {
      const once = fixOnce(script, deps);
      expect(once).toBe(expected);
      const twice = fixOnce(once, deps);
      expect(twice).toBe(once);
    });
  }
});

describe('fix plan: no half-fixed states', () => {
  it('mixed scripts only plan fixes for scripts with replacements', () => {
    const manifest = {
      name: 'x',
      scripts: {
        clean: 'rm -rf dist',
        build: 'NODE_ENV=x vite build',
        ok: 'node ok.js',
      },
    };
    const findings = [
      ...analyzeScript(manifest.scripts.clean as string, ctxFor(manifest.scripts.clean as string)),
      ...analyzeScript(manifest.scripts.build as string, ctxFor(manifest.scripts.build as string)),
    ];
    const result: AnalysisResult = {
      root: '/x',
      packages: [{ relPath: 'package.json', absDir: '/x', manifest }],
      findings,
      summary: { scriptsScanned: 3, packagesScanned: 1, errors: 2, warnings: 0, advisories: 0 },
    };
    const plans = planFixes(result);
    expect(plans).toHaveLength(0); // no deps installed: plans exist, rewrites don't
  });
});

function ctxFor(script: string) {
  return {
    script,
    scriptName: 'x',
    packagePath: 'package.json',
    targets: DEFAULT_TARGETS,
    dependencies: new Set<string>(),
    workspaceBins: new Set<string>(),
  };
}
