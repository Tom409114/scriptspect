import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS001 POSIX_INLINE_ENV', () => {
  it('positive: reports inline env assignments', () => {
    expect(ids(only(run('NODE_ENV=production vite build'), 'PS001'))).toEqual(['PS001']);
    expect(only(run('A=1 B=2 node app.js'), 'PS001')).toHaveLength(1);
    expect(only(run('GIT_AUTHOR_NAME=x npm publish'), 'PS001')).toHaveLength(1);
  });

  it('positive: assignment-only scripts are still POSIX-only', () => {
    expect(only(run('FOO=bar'), 'PS001')).toHaveLength(1);
  });

  it('positive: reports assignments in chained commands', () => {
    expect(only(run('node a.js && B=2 node b.js'), 'PS001')).toHaveLength(1);
  });

  it('negative: cross-env already handles it', () => {
    expect(only(run('cross-env NODE_ENV=production vite build'), 'PS001')).toEqual([]);
  });

  it('negative: plain commands without assignments', () => {
    expect(only(run('vite build'), 'PS001')).toEqual([]);
    expect(only(run('node app.js'), 'PS001')).toEqual([]);
  });

  it('negative: strings containing equals are not assignments', () => {
    expect(only(run('echo "FOO=bar"'), 'PS001')).toEqual([]);
    expect(only(run('vite --mode=production'), 'PS001')).toEqual([]);
  });

  it('negative: not reported when cmd is not an active target', () => {
    expect(only(run('NODE_ENV=x vite build', { targets: ['posix-sh'] }), 'PS001')).toEqual([]);
  });

  it('fix: safe when cross-env is already a dependency', () => {
    const [f] = only(
      run('NODE_ENV=production vite build', { dependencies: new Set(['cross-env']) }),
      'PS001',
    );
    expect(f?.fix?.safety).toBe('safe');
    expect(f?.fix?.replacement?.text).toBe('cross-env ');
  });

  it('fix: conditional (plan only) when cross-env is missing', () => {
    const [f] = only(run('NODE_ENV=production vite build'), 'PS001');
    expect(f?.fix?.safety).toBe('conditional');
    expect(f?.fix?.requiresDependency).toBe('cross-env');
    expect(f?.fix?.replacement).toBeUndefined();
  });
});
