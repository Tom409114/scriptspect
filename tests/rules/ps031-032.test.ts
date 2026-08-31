import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS031 EXPLICIT_CMD', () => {
  it('positive: cmd /c wrapper', () => {
    const findings = only(run('cmd /c "set FOO=bar&& node app.js"'), 'PS031');
    expect(findings).toHaveLength(1);
  });

  it('positive: cmd.exe form', () => {
    expect(only(run('cmd.exe /c dir'), 'PS031')).toHaveLength(1);
  });

  it('wrapper owns the finding; inner tokens are not re-reported', () => {
    expect(ids(run('cmd /c "set FOO=bar&& node app.js"'))).toEqual(['PS031']);
  });

  it('negative: cross-platform commands', () => {
    expect(only(run('node app.js'), 'PS031')).toEqual([]);
    expect(only(run('vite build'), 'PS031')).toEqual([]);
  });

  it('negative: not reported when only targeting cmd', () => {
    expect(only(run('cmd /c "dir"', { targets: ['cmd'] }), 'PS031')).toEqual([]);
  });
});

describe('PS032 EXPLICIT_POWERSHELL', () => {
  it('positive: powershell -Command wrapper', () => {
    expect(only(run('powershell -Command "echo hi"'), 'PS032')).toHaveLength(1);
  });

  it('positive: pwsh and -NoProfile forms', () => {
    expect(only(run('pwsh -Command "echo hi"'), 'PS032')).toHaveLength(1);
    expect(only(run('powershell -NoProfile -Command "echo hi"'), 'PS032')).toHaveLength(1);
  });

  it('wrapper owns the portability finding while unsafe outer expansion gets PS051', () => {
    expect(ids(run(`powershell -Command "$env:FOO='bar'; node app.js"`))).toEqual([
      'PS032',
      'PS051',
    ]);
  });

  it('negative: node scripts', () => {
    expect(only(run('node app.js'), 'PS032')).toEqual([]);
  });

  it('negative: not reported when powershell is an explicit target', () => {
    expect(only(run('pwsh -Command "x"', { targets: ['cmd', 'powershell'] }), 'PS032')).toEqual([]);
  });
});
