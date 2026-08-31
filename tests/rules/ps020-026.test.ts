import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS020 COMMAND_SUBSTITUTION', () => {
  it('positive: $() constructs', () => {
    expect(ids(only(run('node $(npm bin)/jest'), 'PS020'))).toEqual(['PS020']);
    expect(only(run('echo "built at $(date)"'), 'PS020')).toHaveLength(1);
    expect(only(run('rm -rf $(ls dist)'), 'PS020')).toHaveLength(1);
  });

  it('negative: no substitution', () => {
    expect(only(run('node app.js'), 'PS020')).toEqual([]);
    expect(only(run('echo $HOME'), 'PS020')).toEqual([]);
    expect(only(run('echo "$(pwd)" && npx jest'), 'PS020')).toHaveLength(1); // exactly one, for the one $()
  });

  it('nested substitution counts once', () => {
    expect(only(run('echo $(dirname $(pwd))'), 'PS020')).toHaveLength(1);
  });
});

describe('PS021 POSIX_EXPORT', () => {
  it('positive: export statements', () => {
    expect(only(run('export NODE_ENV=production'), 'PS021')).toHaveLength(1);
    expect(only(run('export PATH=$PATH:./bin'), 'PS021')).toHaveLength(1);
    expect(only(run('npm i && export A=1 && node x'), 'PS021')).toHaveLength(1);
  });

  it('negative: strings and cross-env', () => {
    expect(only(run('echo "export A=1"'), 'PS021')).toEqual([]);
    expect(only(run('cross-env NODE_ENV=x node a'), 'PS021')).toEqual([]);
    expect(only(run('node app.js'), 'PS021')).toEqual([]);
  });
});

describe('PS022 POSIX_SOURCE', () => {
  it('positive: source and dot forms', () => {
    expect(only(run('source ./env.sh'), 'PS022')).toHaveLength(1);
    expect(only(run('. ./scripts/env.sh'), 'PS022')).toHaveLength(1);
    expect(only(run('source env.sh && npm t'), 'PS022')).toHaveLength(1);
  });

  it('negative: bare dot and unrelated', () => {
    expect(only(run('node app.js'), 'PS022')).toEqual([]);
    expect(only(run('echo source'), 'PS022')).toEqual([]);
    expect(only(run('vite build'), 'PS022')).toEqual([]);
  });
});

describe('PS023 POSIX_VAR_EXPANSION', () => {
  it('positive: $VAR forms', () => {
    expect(only(run('echo $npm_package_version'), 'PS023')).toHaveLength(1);
    expect(only(run('node build.js --out $' + '{OUT_DIR:-dist}'), 'PS023')).toHaveLength(1);
    expect(only(run('ls $HOME'), 'PS023')).toHaveLength(1);
  });

  it('negative: no dollar expansions', () => {
    expect(only(run('echo hello'), 'PS023')).toEqual([]);
    expect(only(run('vite build'), 'PS023')).toEqual([]);
  });

  it('negative: $env: belongs to PS003', () => {
    expect(only(run("$env:X='1'; node a"), 'PS023')).toEqual([]);
  });

  it('medium confidence, warn severity', () => {
    const [f] = only(run('echo $HOME'), 'PS023');
    expect(f?.confidence).toBe('medium');
    expect(f?.severity).toBe('warn');
  });
});

describe('PS024 CMD_VAR_EXPANSION', () => {
  it('positive: %VAR% forms', () => {
    expect(only(run('echo %APPDATA%'), 'PS024')).toHaveLength(1);
    expect(only(run('mkdir "%USERPROFILE%\\build"'), 'PS024')).toHaveLength(1);
    expect(only(run('node x --p %npm_package_version%'), 'PS024')).toHaveLength(1);
  });

  it('negative: format strings without closing percent', () => {
    expect(only(run("printf '%s\\n' hello"), 'PS024')).toEqual([]);
    expect(only(run('date +%Y-%m-%d'), 'PS024')).toEqual([]);
    expect(only(run('echo 100%'), 'PS024')).toEqual([]);
  });

  it('derives PowerShell as affected for cmd percent expansion syntax', () => {
    const [finding] = only(run('echo %TEMP%', { targets: ['powershell'] }), 'PS024');

    expect(finding?.affectedTargets).toEqual(['powershell']);
  });
});

describe('PS025 DEV_NULL', () => {
  it('positive: /dev/null in args and redirects', () => {
    expect(only(run('node heavy.js > /dev/null'), 'PS025')).toHaveLength(1);
    expect(only(run('cmd 2> /dev/null'), 'PS025')).toHaveLength(1);
    expect(only(run('cat /dev/null'), 'PS025')).toHaveLength(1);
  });

  it('negative: regular files', () => {
    expect(only(run('node heavy.js > out.log'), 'PS025')).toEqual([]);
    expect(only(run('echo /dev'), 'PS025')).toEqual([]);
    expect(only(run('vite build'), 'PS025')).toEqual([]);
  });
});

describe('PS026 UNIX_PATH_ASSUMPTION', () => {
  it('positive: hardcoded unix paths', () => {
    expect(only(run('cp x /tmp/'), 'PS026')).toHaveLength(1);
    expect(only(run('mkdir /usr/local/etc/app'), 'PS026')).toHaveLength(1);
    expect(only(run('ls /var/log'), 'PS026')).toHaveLength(1);
  });

  it('negative: relative paths and urls', () => {
    expect(only(run('cp x ./tmp/'), 'PS026')).toEqual([]);
    expect(only(run('curl http://x/api/y'), 'PS026')).toEqual([]);
    expect(only(run('node app.js'), 'PS026')).toEqual([]);
  });

  it('advisory severity', () => {
    const [f] = only(run('ls /tmp'), 'PS026');
    expect(f?.severity).toBe('advisory');
  });
});
