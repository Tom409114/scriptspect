import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS030 EXPLICIT_BASH', () => {
  it('positive: bash -c wrapper', () => {
    const findings = only(run('bash -c "rm -rf dist"'), 'PS030');
    expect(findings).toHaveLength(1);
  });

  it('positive: sh and zsh wrappers', () => {
    expect(only(run('sh -c "echo hi"'), 'PS030')).toHaveLength(1);
    expect(only(run('zsh -c "echo hi"'), 'PS030')).toHaveLength(1);
  });

  it('positive: bash running a script file', () => {
    expect(only(run('bash scripts/build.sh'), 'PS030')).toHaveLength(1);
  });

  it('does not double-report inner tokens (wrapper owns the finding)', () => {
    const findings = run('bash -c "rm -rf dist"');
    expect(ids(findings)).toEqual(['PS030']);
  });

  it('negative: node scripts are cross-platform', () => {
    expect(only(run('node scripts/build.js'), 'PS030')).toEqual([]);
  });

  it('negative: cross-platform tools', () => {
    expect(only(run('rimraf dist'), 'PS030')).toEqual([]);
    expect(only(run('shx rm -rf dist'), 'PS030')).toEqual([]);
  });

  it('fix is manual (dependency declaration decision)', () => {
    const [f] = only(run('bash -c "echo hi"'), 'PS030');
    expect(f?.fix?.safety).toBe('manual');
  });
});
