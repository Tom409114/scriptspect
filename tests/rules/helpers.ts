/** Shared helpers for rule tests: minimal context + result shaping. */

import { DEFAULT_TARGETS } from '../../src/core/targets';
import { analyzeScript } from '../../src/rules/index';
import type { Finding, RuleContext } from '../../src/rules/types';

export function makeCtx(partial: Partial<RuleContext> = {}): RuleContext {
  return {
    script: '',
    scriptName: 'test',
    packagePath: 'package.json',
    targets: DEFAULT_TARGETS,
    dependencies: new Set<string>(),
    workspaceBins: new Set<string>(),
    ...partial,
  };
}

export function run(script: string, partial: Partial<RuleContext> = {}): Finding[] {
  return analyzeScript(script, makeCtx({ ...partial, script }));
}

export function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.ruleId);
}

export function only(findings: Finding[], ruleId: string): Finding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}
