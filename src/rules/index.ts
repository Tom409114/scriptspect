/**
 * Rule registry and engine. Rules are standalone modules; the engine runs
 * each rule, applies config severity overrides, filters by active targets
 * and (optionally) by rule id, and returns deterministic sorted findings.
 */

import { sortFindings } from '../core/finding';
import { ALL_TARGETS } from '../core/targets';
import type { CommandNode, ParseMatrix, ScriptNode, ShellTarget } from '../parser/ir';
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

/** Derived from the rule factory so a command fixer cannot bypass safety gates by registry omission. */
export const AUTOMATIC_COMMAND_RULE_IDS: readonly string[] = RULES.filter(
  (rule) => rule.automaticReplacementKind === 'command',
).map(({ id }) => id);

const AUTOMATIC_COMMAND_FIXER_IDS: ReadonlySet<string> = new Set(AUTOMATIC_COMMAND_RULE_IDS);

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
  const automaticCommandReplacement = AUTOMATIC_COMMAND_FIXER_IDS.has(finding.ruleId);
  for (const target of matrix.activeTargets) {
    const parsed = matrix.byTarget.get(target);
    if (parsed === undefined) return true;
    if (
      automaticCommandReplacement &&
      parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ) {
      return true;
    }
    const guardedSpans: [number, number][] = [finding.span, replacement.span];
    if (automaticCommandReplacement) {
      guardedSpans.push(
        ...findCommandMatches(parsed.root, finding.span).map(({ command }) => command.span),
      );
    }
    if (
      parsed.diagnostics.some((diagnostic) =>
        guardedSpans.some((span) => spansIntersect(diagnostic.span, span)),
      )
    ) {
      return true;
    }
  }
  if (automaticCommandReplacement && !hasEquivalentCommandShape(matrix, finding)) {
    return true;
  }
  return !hasStableReplacementRole(matrix, finding);
}

interface CommandRoleSegment {
  kind: 'sequence' | 'boolean' | 'pipeline' | 'group' | 'case' | 'compound';
  span: [number, number];
  index?: number;
  before?: { op: string; span: [number, number] };
  after?: { op: string; span: [number, number] };
}

interface CommandMatch {
  command: CommandNode;
  role: CommandRoleSegment[];
}

/**
 * An automatic command edit is valid only when it addresses one identical
 * command in every active shell graph. This closes gaps where one dialect
 * treats bytes as argv while another treats them as separators, escapes,
 * comments, or redirections.
 */
function hasEquivalentCommandShape(matrix: ParseMatrix, finding: Finding): boolean {
  let expected: string | undefined;
  for (const target of matrix.activeTargets) {
    const root = matrix.byTarget.get(target)?.root;
    if (root === undefined) return false;
    const matches = findCommandMatches(root, finding.span);
    if (matches.length !== 1) return false;
    const match = matches[0];
    if (match === undefined) return false;
    const actual = JSON.stringify(commandShape(match));
    expected ??= actual;
    if (actual !== expected) return false;
  }
  return expected !== undefined;
}

function findCommandMatches(
  node: ScriptNode,
  executableSpan: [number, number],
  role: CommandRoleSegment[] = [],
): CommandMatch[] {
  if (node.kind === 'command') {
    const executable = node.argv[0];
    return executable !== undefined && spansEqual(executable.span, executableSpan)
      ? [{ command: node, role }]
      : [];
  }
  if (node.kind === 'group') {
    return findCommandMatches(node.body, executableSpan, [
      ...role,
      { kind: 'group', span: node.span },
    ]);
  }

  const matches: CommandMatch[] = [];
  node.parts.forEach((part, index) => {
    const beforeIndex = index - 1;
    const hasOperators = node.kind !== 'case' && node.kind !== 'compound';
    const beforeOp = hasOperators && beforeIndex >= 0 ? operatorAt(node, beforeIndex) : undefined;
    const afterOp = hasOperators ? operatorAt(node, index) : undefined;
    matches.push(
      ...findCommandMatches(part, executableSpan, [
        ...role,
        {
          kind: node.kind,
          span: node.span,
          index,
          ...(beforeOp === undefined ? {} : { before: beforeOp }),
          ...(afterOp === undefined ? {} : { after: afterOp }),
        },
      ]),
    );
  });
  return matches;
}

function operatorAt(
  node: Exclude<
    ScriptNode,
    CommandNode | { kind: 'group' } | { kind: 'case' } | { kind: 'compound' }
  >,
  index: number,
): { op: string; span: [number, number] } | undefined {
  const span = node.opSpans[index];
  if (span === undefined) return undefined;
  const op = node.kind === 'pipeline' ? '|' : node.ops[index];
  return op === undefined ? undefined : { op, span };
}

function commandShape(match: CommandMatch): object {
  const { command, role } = match;
  return {
    span: command.span,
    raw: command.raw,
    argv: command.argv.map(tokenShape),
    leadingEnv: command.leadingEnv.map(({ name, value, span }) => ({ name, value, span })),
    redirects: command.redirects.map(({ op, span, target }) => ({
      op,
      span,
      target: target === null ? null : tokenShape(target),
    })),
    wrapper:
      command.wrapper === undefined
        ? null
        : {
            shell: command.wrapper.shell,
            raw: command.wrapper.raw,
            span: command.wrapper.span,
            payloadTarget: command.wrapper.payloadTarget,
            payloadSupport: command.wrapper.payloadSupport,
            payloadSourceSpan: command.wrapper.payloadSourceSpan,
            payloadRaw: command.wrapper.payloadRaw,
          },
    role,
  };
}

function tokenShape(token: CommandNode['argv'][number]): object {
  return {
    raw: token.raw,
    value: token.value,
    span: token.span,
    quote: token.quote,
    expansions: token.expansions.map(({ kind, raw, span }) => ({ kind, raw, span })),
  };
}

function spansEqual(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
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
