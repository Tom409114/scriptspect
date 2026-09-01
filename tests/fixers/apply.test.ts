import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../../src/core/targets';
import { applicableFixes, applyToScript } from '../../src/fixers/apply';
import { analyzeScript } from '../../src/rules';
import type { Finding, RuleContext } from '../../src/rules/types';

function run(script: string, deps: string[] = []): Finding[] {
  const ctx: RuleContext = {
    script,
    scriptName: 'test',
    packagePath: 'package.json',
    targets: DEFAULT_TARGETS,
    dependencies: new Set(deps),
    workspaceBins: new Set(),
  };
  return analyzeScript(script, ctx);
}

function fix(script: string, deps: string[] = []): string {
  return applyToScript(script, run(script, deps)).script;
}

describe('fix engine: cross-env (PS001)', () => {
  it('inserts cross-env when it is already a dependency', () => {
    expect(fix('NODE_ENV=production vite build', ['cross-env'])).toBe(
      'cross-env NODE_ENV=production vite build',
    );
  });

  it('does not touch the script when cross-env is missing (plan only)', () => {
    expect(fix('NODE_ENV=production vite build')).toBe('NODE_ENV=production vite build');
    const [f] = run('NODE_ENV=production vite build');
    expect(f?.fix?.requiresDependency).toBe('cross-env');
    expect(f?.fix?.replacement).toBeUndefined();
  });

  it('leaves already-cross-env scripts alone', () => {
    expect(applicableFixes(run('cross-env NODE_ENV=x vite build', ['cross-env']))).toHaveLength(0);
  });
});

describe('fix engine: rimraf (PS010)', () => {
  it('folds rm -rf into rimraf when rimraf is a dependency', () => {
    expect(fix('rm -rf dist', ['rimraf'])).toBe('rimraf dist');
  });

  it('does not treat rimraf as equivalent to non-force rm', () => {
    expect(fix('rm -r build', ['rimraf'])).toBe('rm -r build');
    expect(fix('rm temp.log', ['rimraf'])).toBe('rm temp.log');
  });

  it('falls back to shx rm when only shx is present', () => {
    expect(fix('rm -rf dist', ['shx'])).toBe('shx rm -rf dist');
  });

  it('plans (no rewrite) when neither rimraf nor shx is installed', () => {
    expect(fix('rm -rf dist')).toBe('rm -rf dist');
    const [f] = run('rm -rf dist');
    expect(f?.fix?.requiresDependency).toBe('rimraf');
  });
});

describe('fix engine: shx prefixes (PS011-PS018)', () => {
  it('prefixes the proven cp/mv/mkdir -p/grep/sed subsets with shx when installed', () => {
    expect(fix('cp -r src dist', ['shx'])).toBe('shx cp -r src dist');
    expect(fix('mv a b', ['shx'])).toBe('shx mv a b');
    expect(fix('mkdir -p dist/assets', ['shx'])).toBe('shx mkdir -p dist/assets');
    expect(fix('grep -in TODO src/app.ts', ['shx'])).toBe('shx grep -in TODO src/app.ts');
    expect(fix('sed "s/a/b/" x', ['shx'])).toBe('shx sed "s/a/b/" x');
  });

  it('does not prefix cat because file contents may be binary', () => {
    expect(fix('cat a.json > b.json', ['shx'])).toBe('cat a.json > b.json');
    expect(fix('cat assets/logo.png', ['shx'])).toBe('cat assets/logo.png');
  });

  it('plans (no rewrite) when shx is missing', () => {
    expect(fix('cp -r src dist')).toBe('cp -r src dist');
    const [f] = run('cp -r src dist');
    expect(f?.fix?.requiresDependency).toBe('shx');
  });

  it('never prefixes an already-shx command', () => {
    expect(applicableFixes(run('shx cp -r src dist', ['shx']))).toHaveLength(0);
  });
});

describe('fix engine: safety invariants', () => {
  it('multiple fixes in one script apply in source order', () => {
    const out = fix('NODE_ENV=x vite build && rm -rf dist', ['cross-env', 'rimraf']);
    expect(out).toBe('cross-env NODE_ENV=x vite build && rimraf dist');
  });

  it('manual fixes never carry replacements', () => {
    for (const f of run('bash -c "echo hi" && which node')) {
      if (f.fix !== undefined) {
        expect(f.fix.replacement).toBeUndefined();
      }
    }
  });
});
