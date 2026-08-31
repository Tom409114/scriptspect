/**
 * Rule registry and engine. Rules are standalone modules; the engine runs
 * each rule, applies config severity overrides, filters by active targets
 * and (optionally) by rule id, and returns deterministic sorted findings.
 */

import { sortFindings } from '../core/finding';
import type { ShellTarget } from '../parser/ir';
import { parseScript } from '../parser/parse';
import { PS001 } from './PS001';
import { PS002 } from './PS002';
import { PS003 } from './PS003';
import { PS030 } from './PS030';
import { PS031 } from './PS031';
import { PS032 } from './PS032';
import type { Finding, RuleContext, RuleModule, Severity } from './types';

export const RULES: readonly RuleModule[] = [PS001, PS002, PS003, PS030, PS031, PS032];

export function getRule(id: string): RuleModule | undefined {
  return RULES.find((r) => r.id === id);
}

export interface RunOptions {
  /** Restrict to specific rule ids (CLI `--rule`). */
  onlyRules?: ReadonlySet<string>;
  /** Config severity overrides: rule id -> severity. */
  severityOverrides?: ReadonlyMap<string, Severity>;
}

/** Analyze one script string and return findings for the active targets. */
export function analyzeScript(
  script: string,
  ctx: RuleContext,
  options: RunOptions = {},
): Finding[] {
  const ir = parseScript(script);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (options.onlyRules !== undefined && !options.onlyRules.has(rule.id)) continue;
    for (const finding of rule.check(ir, ctx)) {
      const override = options.severityOverrides?.get(rule.id);
      findings.push(override === undefined ? finding : { ...finding, severity: override });
    }
  }
  return sortFindings(findings);
}

export type { Finding, RuleContext, RuleModule, Severity, ShellTarget };
