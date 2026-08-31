import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS010 POSIX_RM', () => {
  it('positive: rm in command position', () => {
    expect(ids(only(run('rm -rf dist'), 'PS010'))).toEqual(['PS010']);
    expect(only(run('rm -r build'), 'PS010')).toHaveLength(1);
    expect(only(run('rm temp.log && npm test'), 'PS010')).toHaveLength(1);
  });

  it('negative: cross-platform replacements and strings', () => {
    expect(only(run('rimraf dist'), 'PS010')).toEqual([]);
    expect(only(run('shx rm -rf dist'), 'PS010')).toEqual([]);
    expect(only(run('echo "rm -rf dist"'), 'PS010')).toEqual([]);
  });

  it('negative: inside bash wrapper (PS030 owns it)', () => {
    expect(ids(run('bash -c "rm -rf dist"'))).toEqual(['PS030']);
  });

  it('error severity, cmd affected', () => {
    const [f] = only(run('rm -rf dist'), 'PS010');
    expect(f?.severity).toBe('error');
    expect(f?.affectedTargets).toEqual(['cmd']);
  });
});

describe('PS011 POSIX_CP', () => {
  it('positive: cp variants', () => {
    expect(ids(only(run('cp -r src dist'), 'PS011'))).toEqual(['PS011']);
    expect(only(run('cp a.txt b.txt'), 'PS011')).toHaveLength(1);
    expect(only(run('cp -r a b && npm test'), 'PS011')).toHaveLength(1);
  });

  it('negative: shx cp and strings', () => {
    expect(only(run('shx cp -r src dist'), 'PS011')).toEqual([]);
    expect(only(run('node -e "console.log(\'cp -r\')"'), 'PS011')).toEqual([]);
    expect(only(run('vite build'), 'PS011')).toEqual([]);
  });
});

describe('PS012 POSIX_MV', () => {
  it('positive: mv variants', () => {
    expect(ids(only(run('mv dist build'), 'PS012'))).toEqual(['PS012']);
    expect(only(run('mv old.json new.json'), 'PS012')).toHaveLength(1);
    expect(only(run('shx ls && mv a b'), 'PS012')).toHaveLength(1);
  });

  it('negative: shx mv and unrelated commands', () => {
    expect(only(run('shx mv dist build'), 'PS012')).toEqual([]);
    expect(only(run('node app.js'), 'PS012')).toEqual([]);
    expect(only(run('echo "mv x y"'), 'PS012')).toEqual([]);
  });
});

describe('PS013 POSIX_MKDIR_P', () => {
  it('positive: mkdir -p forms', () => {
    expect(ids(only(run('mkdir -p dist/assets'), 'PS013'))).toEqual(['PS013']);
    expect(only(run('mkdir -p a/b/c && npm run build'), 'PS013')).toHaveLength(1);
    expect(only(run('mkdir --parents x'), 'PS013')).toHaveLength(1);
  });

  it('negative: plain mkdir exists on cmd too', () => {
    expect(only(run('mkdir dist'), 'PS013')).toEqual([]);
    expect(only(run('mkdir src lib'), 'PS013')).toEqual([]);
  });

  it('negative: shx mkdir and strings', () => {
    expect(only(run('shx mkdir -p dist'), 'PS013')).toEqual([]);
    expect(only(run('echo "mkdir -p x"'), 'PS013')).toEqual([]);
    expect(only(run('vite build'), 'PS013')).toEqual([]);
  });
});
