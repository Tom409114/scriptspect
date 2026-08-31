import { describe, expect, it } from 'vitest';
import { analyzeScript, getRule } from '../../src/rules/index';
import { makeCtx } from './helpers';

function analyze(
  script: string,
  targets: Array<'posix-sh' | 'cmd' | 'powershell'>,
  onlyRules?: string[],
) {
  return analyzeScript(script, makeCtx({ script, targets }), {
    onlyRules: onlyRules === undefined ? undefined : new Set(onlyRules),
  });
}

describe('matrix-backed rule evidence', () => {
  it('uses the cmd graph when backslash does not escape an ampersand', () => {
    const findings = analyze('echo left \\& rm -rf dist', ['cmd'], ['PS010']);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'PS010', affectedTargets: ['cmd'] });
  });

  it('withholds a command replacement unless the span is command-position in every active graph', () => {
    const script = 'echo foo \\& rm -rf dist';
    const [finding] = analyzeScript(
      script,
      makeCtx({
        script,
        targets: ['posix-sh', 'cmd'],
        dependencies: new Set(['rimraf']),
      }),
      { onlyRules: new Set(['PS010']) },
    );

    expect(finding).toMatchObject({ ruleId: 'PS010', affectedTargets: ['cmd'] });
    expect(finding?.fix?.replacement).toBeUndefined();
  });

  it('does not manufacture a cmd command behind a POSIX leading assignment', () => {
    expect(analyze('FOO=1 rm -rf dist', ['posix-sh', 'cmd'], ['PS010'])).toEqual([]);
  });

  it('uses cmd expansion evidence inside characters POSIX treats as single quotes', () => {
    const findings = analyze("echo '%TEMP%'", ['posix-sh'], ['PS024']);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'PS024', affectedTargets: ['posix-sh'] });
  });

  it('merges repeated target evidence into one deterministic affected-target union', () => {
    const findings = analyze('vite build', ['cmd', 'powershell'], ['PS040']);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'PS040',
        affectedTargets: ['cmd', 'powershell'],
      }),
    ]);
  });
});

describe('PS051 target shell parse diagnostics', () => {
  it('ships the documented static metadata contract', () => {
    expect(getRule('PS051')).toMatchObject({
      id: 'PS051',
      severity: 'advisory',
      confidence: 'medium',
      affectedTargets: ['posix-sh', 'cmd', 'powershell'],
      fixSafety: 'manual',
    });
  });

  it('emits deterministic syntax errors only for the active target', () => {
    const activePosix = analyze("echo 'oops", ['posix-sh'], ['PS051']);
    const evidenceOnlyPosix = analyze("echo 'oops", ['cmd'], ['PS051']);

    expect(activePosix).toEqual([
      expect.objectContaining({
        ruleId: 'PS051',
        severity: 'error',
        confidence: 'high',
        affectedTargets: ['posix-sh'],
        span: [5, 10],
      }),
    ]);
    expect(evidenceOnlyPosix).toEqual([]);
  });

  it('does not treat an unmatched cmd double quote as a deterministic error', () => {
    expect(analyze('echo "oops', ['cmd'], ['PS051'])).toEqual([]);
  });

  it('does not report valid quoted commands supported by every active target', () => {
    expect(
      analyze('node app.js --message "ready now"', ['posix-sh', 'cmd', 'powershell'], ['PS051']),
    ).toEqual([]);
  });

  it('emits PowerShell subset boundaries as advisory medium findings', () => {
    expect(analyze('echo $HOME', ['powershell'], ['PS051'])).toEqual([
      expect.objectContaining({
        ruleId: 'PS051',
        severity: 'advisory',
        confidence: 'medium',
        affectedTargets: ['powershell'],
        span: [5, 10],
      }),
    ]);
  });

  it('source-maps definite syntax errors inside supported wrapper payloads', () => {
    expect(analyze('bash -c "echo \'oops"', ['posix-sh'], ['PS051'])).toEqual([
      expect.objectContaining({
        ruleId: 'PS051',
        severity: 'error',
        confidence: 'high',
        affectedTargets: ['posix-sh'],
        span: [14, 19],
      }),
    ]);
  });

  it('merges identical diagnostics without retaining a single-target message prefix', () => {
    expect(analyze("echo 'oops", ['posix-sh', 'powershell'], ['PS051'])).toEqual([
      expect.objectContaining({
        affectedTargets: ['posix-sh', 'powershell'],
        message: 'Unterminated single quote',
      }),
    ]);
  });
});

describe('matrix diagnostic fix gates', () => {
  it('keeps a replacement when an unrelated diagnostic is elsewhere in the script', () => {
    const script = 'rm -rf $HOME';
    const [finding] = analyzeScript(
      script,
      makeCtx({
        script,
        targets: ['cmd', 'powershell'],
        dependencies: new Set(['rimraf']),
      }),
      { onlyRules: new Set(['PS010']) },
    );

    expect(finding?.ruleId).toBe('PS010');
    expect(finding?.fix?.safety).toBe('safe');
    expect(finding?.fix?.replacement).toEqual({ span: [0, 7], text: 'rimraf ' });
  });

  it('omits a replacement when a diagnostic intersects the command span', () => {
    const script = '(rm -rf dist)';
    const [finding] = analyzeScript(
      script,
      makeCtx({
        script,
        targets: ['cmd', 'powershell'],
        dependencies: new Set(['rimraf']),
      }),
      { onlyRules: new Set(['PS010']) },
    );

    expect(finding?.fix?.replacement).toBeUndefined();
  });
});
