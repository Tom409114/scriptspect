/**
 * Rule registry and engine. Rules are standalone modules; the engine runs
 * each rule, applies config severity overrides, filters by active targets
 * and (optionally) by rule id, and returns deterministic sorted findings.
 */

import { sortFindings } from '../core/finding';
import { ALL_TARGETS } from '../core/targets';
import type { CommandNode, ParseMatrix, ShellTarget } from '../parser/ir';
import { walkCommands } from '../parser/ir';
import { parseMatrix } from '../parser/parse';
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
import { PS051 } from './PS051';
import type { Finding, RuleContext, RuleModule, Severity } from './types';

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
  PS051,
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
export function analyzeScript(
  script: string,
  ctx: RuleContext,
  options: RunOptions = {},
): Finding[] {
  const selectedRules = RULES.filter(
    (rule) => options.onlyRules === undefined || options.onlyRules.has(rule.id),
  );
  const matrix = parseMatrix(
    script,
    new Set(ctx.targets),
    new Set(selectedRules.map((rule) => rule.id)),
  );
  const findings: Finding[] = [];
  for (const rule of selectedRules) {
    for (const finding of rule.check(matrix, ctx)) {
      const override = options.severityOverrides?.get(rule.id);
      const gated = shouldGateReplacement(matrix, finding)
        ? withoutAutomaticReplacement(finding)
        : finding;
      findings.push(override === undefined ? gated : { ...gated, severity: override });
    }
  }
  return sortFindings(mergeFindings(findings));
}

function mergeFindings(findings: readonly Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const replacement = finding.fix?.replacement;
    const key = [
      finding.ruleId,
      finding.span[0],
      finding.span[1],
      finding.subtype ?? '',
      replacement?.span[0] ?? '',
      replacement?.span[1] ?? '',
      replacement?.text ?? '',
    ].join(':');
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, finding);
      continue;
    }
    const targetSet = new Set([...existing.affectedTargets, ...finding.affectedTargets]);
    existing.affectedTargets = ALL_TARGETS.filter((target) => targetSet.has(target));
  }
  return [...merged.values()];
}

function withoutAutomaticReplacement(finding: Finding): Finding {
  if (finding.fix === undefined) return finding;
  return { ...finding, fix: { ...finding.fix, replacement: undefined } };
}

function shouldGateReplacement(matrix: ParseMatrix, finding: Finding): boolean {
  const replacement = finding.fix?.replacement;
  if (replacement === undefined) return false;
  for (const target of matrix.activeTargets) {
    const parsed = matrix.byTarget.get(target);
    if (parsed === undefined) return true;
    if (
      parsed.diagnostics.some(
        (diagnostic) =>
          spansIntersect(diagnostic.span, finding.span) ||
          spansIntersect(diagnostic.span, replacement.span),
      )
    ) {
      return true;
    }
  }
  return !hasStableReplacementRole(matrix, finding);
}

function spansIntersect(left: [number, number], right: [number, number]): boolean {
  if (left[0] === left[1]) return right[0] <= left[0] && left[0] < right[1];
  if (right[0] === right[1]) return left[0] <= right[0] && right[0] < left[1];
  return left[0] < right[1] && right[0] < left[1];
}

function hasStableReplacementRole(matrix: ParseMatrix, finding: Finding): boolean {
  const replacement = finding.fix?.replacement;
  if (replacement === undefined) return true;
  for (const target of matrix.activeTargets) {
    const root = matrix.byTarget.get(target)?.root;
    if (root === undefined) return false;
    const commands = [...walkCommands(root)];
    const stable =
      finding.ruleId === 'PS001'
        ? commands.some((command) => isStableCommandPrefix(command, replacement.span[0]))
        : commands.some((command) => isStableCommandRewrite(command, replacement.span));
    if (!stable) return false;
  }
  return true;
}

function isStableCommandPrefix(command: CommandNode, position: number): boolean {
  if (command.span[0] !== position) return false;
  return (
    command.leadingEnv.some((assignment) => assignment.span[0] === position) ||
    command.argv.some((token) => token.span[0] === position)
  );
}

function isStableCommandRewrite(command: CommandNode, span: [number, number]): boolean {
  const executable = command.argv[0];
  if (executable === undefined || executable.span[0] !== span[0]) return false;
  if (span[0] === span[1] || span[1] === executable.span[1]) return true;
  return command.argv.slice(1).some((token) => token.span[0] === span[1]);
}

export type { Finding, RuleContext, RuleModule, Severity, ShellTarget };
