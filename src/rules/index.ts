/**
 * Rule registry and engine. Rules are standalone modules; the engine runs
 * each rule, applies config severity overrides, filters by active targets
 * and (optionally) by rule id, and returns deterministic sorted findings.
 */
import { parseScript } from '../parser/parse';
import { sortFindings } from '../core/finding';
import type { Finding, RuleContext, RuleModule, Severity } from './types';
import type { ShellTarget } from '../parser/ir';
import { PS001 } from './PS001';
import { PS002 } from './PS002';
import { PS003 } from './PS003';
import { PS010 } from './PS010';
import { PS011 } from './PS011';
import { PS012 } from './PS012';
import { PS013 } from './PS013';
import { PS014 } from './PS014';
import { PS015 } from './PS015';
import { PS016 } from './PS016';
import { PS017 } from './PS017';
import { PS018 } from './PS018';
import { PS019 } from './PS019';
import { PS020 } from './PS020';
import { PS021 } from './PS021';
import { PS022 } from './PS022';
import { PS023 } from './PS023';
import { PS024 } from './PS024';
import { PS025 } from './PS025';
import { PS026 } from './PS026';
import { PS030 } from './PS030';
import { PS031 } from './PS031';
import { PS032 } from './PS032';
import { PS040 } from './PS040';
import { PS041 } from './PS041';
import { PS050 } from './PS050';

export const RULES: readonly RuleModule[] = [
  PS001,
  PS002,
  PS003,
  PS010,
  PS011,
  PS012,
  PS013,
  PS014,
  PS015,
  PS016,
  PS017,
  PS018,
  PS019,
  PS020,
  PS021,
  PS022,
  PS023,
  PS024,
  PS025,
  PS026,
  PS030,
  PS031,
  PS032,
  PS040,
  PS041,
  PS050,
];

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
export function analyzeScript(script: string, ctx: RuleContext, options: RunOptions = {}): Finding[] {
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

export type { Finding, RuleContext, RuleModule, Severity };
export type { ShellTarget };
