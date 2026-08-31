import { describe, expect, it } from 'vitest';
import { only, run } from './helpers';

describe('PS002 CMD_SET_ENV', () => {
  it('positive: set NAME=value&& chain', () => {
    const findings = only(run('set NODE_ENV=production&& node app.js'), 'PS002');
    expect(findings).toHaveLength(1);
  });

  it('positive: set with trailing space variants', () => {
    expect(only(run('set FOO=bar&& vite build'), 'PS002')).toHaveLength(1);
    expect(only(run('set FOO=bar && vite build'), 'PS002')).toHaveLength(1);
  });

  it('positive: inside a longer chain', () => {
    expect(only(run('node a.js && set X=1&& node b.js'), 'PS002')).toHaveLength(1);
  });

  it('negative: POSIX set options are not env assignments', () => {
    expect(only(run('set -e'), 'PS002')).toEqual([]);
    expect(only(run('set -o pipefail && npm test'), 'PS002')).toEqual([]);
  });

  it('negative: plain set without NAME=value argument', () => {
    expect(only(run('set'), 'PS002')).toEqual([]);
  });

  it('negative: other commands', () => {
    expect(only(run('node app.js'), 'PS002')).toEqual([]);
  });

  it('severity is warn and affected target is posix-sh', () => {
    const [f] = only(run('set X=1&& node b'), 'PS002');
    expect(f?.severity).toBe('warn');
    expect(f?.affectedTargets).toEqual(['posix-sh']);
  });

  it('derives PowerShell as affected when it is the only active non-cmd target', () => {
    const [finding] = only(run('set X=1&& node b', { targets: ['powershell'] }), 'PS002');

    expect(finding?.affectedTargets).toEqual(['powershell']);
  });
});
