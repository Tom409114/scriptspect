import { describe, expect, it } from 'vitest';
import { only, run } from './helpers';

describe('PS014 POSIX_TOUCH', () => {
  it('positive: touch usage', () => {
    expect(only(run('touch build.timestamp'), 'PS014')).toHaveLength(1);
    expect(only(run('touch src/generated.ts'), 'PS014')).toHaveLength(1);
    expect(only(run('mkdir d && touch d/x'), 'PS014')).toHaveLength(1);
  });

  it('negative: not touch in other positions', () => {
    expect(only(run('echo "touch x"'), 'PS014')).toEqual([]);
    expect(only(run('vite build --touch'), 'PS014')).toEqual([]);
    expect(only(run('node app.js'), 'PS014')).toEqual([]);
  });
});

describe('PS015 POSIX_CHMOD', () => {
  it('positive: chmod usage', () => {
    expect(only(run('chmod +x scripts/deploy.sh'), 'PS015')).toHaveLength(1);
    expect(only(run('chmod 755 build'), 'PS015')).toHaveLength(1);
    expect(only(run('chmod -R 644 lib'), 'PS015')).toHaveLength(1);
  });

  it('negative: strings and wrappers', () => {
    expect(only(run('echo "chmod +x x"'), 'PS015')).toEqual([]);
    expect(only(run('bash -c "chmod +x x"'), 'PS015')).toEqual([]);
    expect(only(run('node app.js'), 'PS015')).toEqual([]);
  });

  it('affects cmd and powershell', () => {
    const [f] = only(run('chmod +x x'), 'PS015');
    expect(f?.affectedTargets).toEqual(['cmd', 'powershell']);
    expect(f?.severity).toBe('warn');
  });
});

describe('PS016 POSIX_WHICH', () => {
  it('positive: which usage', () => {
    expect(only(run('which node'), 'PS016')).toHaveLength(1);
    expect(only(run('which python3'), 'PS016')).toHaveLength(1);
    expect(only(run('which pnpm && npm t'), 'PS016')).toHaveLength(1);
  });

  it('negative: other commands', () => {
    expect(only(run('node -v'), 'PS016')).toEqual([]);
    expect(only(run('echo "which node"'), 'PS016')).toEqual([]);
    expect(only(run('ls'), 'PS016')).toEqual([]);
  });
});

describe('PS017 POSIX_GREP', () => {
  it('positive: grep usage', () => {
    expect(only(run('grep -r "TODO" src'), 'PS017')).toHaveLength(1);
    expect(only(run('cat x | grep y'), 'PS017')).toHaveLength(1);
    expect(only(run('grep -q foo file'), 'PS017')).toHaveLength(1);
  });

  it('negative: shx grep and strings', () => {
    expect(only(run('shx grep -r "TODO" src'), 'PS017')).toEqual([]);
    expect(only(run('echo "grep x"'), 'PS017')).toEqual([]);
    expect(only(run('node app.js'), 'PS017')).toEqual([]);
  });
});

describe('PS018 POSIX_SED', () => {
  it('positive: sed usage', () => {
    expect(only(run("sed -i 's/foo/bar/' file.txt"), 'PS018')).toHaveLength(1);
    expect(only(run("sed 's/a/b/g' x > y"), 'PS018')).toHaveLength(1);
    expect(only(run("cat c | sed 's/x/y/'"), 'PS018')).toHaveLength(1);
  });

  it('negative: shx sed and strings', () => {
    expect(only(run('shx sed "s/a/b/g" x'), 'PS018')).toEqual([]);
    expect(only(run('echo "sed s/x/y/"'), 'PS018')).toEqual([]);
    expect(only(run('node scripts/replace.js'), 'PS018')).toEqual([]);
  });
});

describe('PS019 POSIX_CAT', () => {
  it('positive: cat usage', () => {
    expect(only(run('cat a.json > b.json'), 'PS019')).toHaveLength(1);
    expect(only(run('cat CHANGELOG.md'), 'PS019')).toHaveLength(1);
    expect(only(run('cat x | head -5'), 'PS019')).toHaveLength(1);
  });

  it('negative: shx cat and strings', () => {
    expect(only(run('shx cat config/base.json'), 'PS019')).toEqual([]);
    expect(only(run('echo "cat x"'), 'PS019')).toEqual([]);
    expect(only(run('concat-cli x'), 'PS019')).toEqual([]);
  });
});
