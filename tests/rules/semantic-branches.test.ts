import { describe, expect, it } from 'vitest';
import { only, run } from './helpers';

describe('rule semantic branches', () => {
  it('does not emit target-specific command rules when that target is inactive', () => {
    expect(only(run('rm -rf dist', { targets: ['posix-sh'] }), 'PS010')).toEqual([]);
    expect(only(run('chmod +x tool', { targets: ['posix-sh'] }), 'PS015')).toEqual([]);
  });

  it('recognizes each supported mkdir parents flag form and rejects unrelated flags', () => {
    expect(only(run('mkdir --parents dist'), 'PS013')).toHaveLength(1);
    expect(only(run('mkdir -ap dist'), 'PS013')).toHaveLength(1);
    expect(only(run('mkdir -x dist'), 'PS013')).toEqual([]);
  });

  it('requires an operand for the dot form of source', () => {
    expect(only(run('.'), 'PS022')).toEqual([]);
    expect(only(run('. ./env.sh'), 'PS022')).toHaveLength(1);
  });

  it('finds expansions used as redirection operands', () => {
    expect(only(run('echo ok > $(mktemp)'), 'PS020')).toHaveLength(1);
    expect(only(run('echo ok > $OUT'), 'PS023')).toHaveLength(1);
    expect(only(run('echo ok > %OUT%'), 'PS024')).toHaveLength(1);
  });

  it('derives target-local file and executable findings for optional targets', () => {
    expect(
      only(run('cat /dev/null', { targets: ['powershell'] }), 'PS025')[0]?.affectedTargets,
    ).toEqual(['powershell']);
    expect(only(run('tool.exe', { targets: ['cmd'] }), 'PS041')).toEqual([]);
  });
});
