/**
 * PS050 — SHELL_SPECIFIC_SEPARATOR: active target parses assign different
 * command/operator/redirection roles to the same source bytes.
 */
import { makeFinding } from '../core/finding';
import type { ParseTarget, ScriptNode } from '../parser/ir';
import type { Finding, RuleContext, RuleModule } from './types';

interface GraphFeature {
  role: string;
  span: [number, number];
}

interface Divergence {
  span: [number, number];
  roles: ReadonlyMap<ParseTarget, string>;
}

export const PS050: RuleModule = {
  id: 'PS050',
  title: 'SHELL_SPECIFIC_SEPARATOR',
  summary: 'Target shells assign different structural roles to the same script bytes.',
  severity: 'advisory',
  confidence: 'medium',
  affectedTargets: ['posix-sh', 'cmd'],
  badExamples: ['a; b  (broken on cmd)', 'a & b  (background on sh, sequence on cmd)'],
  goodExamples: ['a && b', 'a || b', 'run-s a b'],
  falsePositiveNotes:
    'Advisory by design — the mismatch is semantic, not a hard failure. `&&`, `||`, and `|` behave equivalently for script purposes and are never reported.',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_09_05',
      claim: 'POSIX `;` sequences commands and single `&` runs asynchronously.',
    },
    {
      source:
        'https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc772390(v=ws.11)',
      claim:
        'cmd.exe uses `&` to sequence and has no `;` separator (`;` is a token separator in some contexts, not a command separator).',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const active = ctx.targets.filter(
      (target): target is 'posix-sh' | 'cmd' =>
        target !== 'powershell' && matrix.activeTargets.has(target),
    );
    if (active.length < 2) return [];
    const features = new Map<ParseTarget, GraphFeature[]>();
    for (const target of active) {
      const root = matrix.byTarget.get(target)?.root;
      if (root !== undefined) features.set(target, collectGraphFeatures(root, target));
    }
    const divergences = graphDivergences(matrix.source, active, features);
    const operatorDivergences = divergences.filter((entry) =>
      [...entry.roles.values()].some(isOperatorRole),
    );
    const selected = operatorDivergences.length > 0 ? operatorDivergences : divergences;
    const findings: Finding[] = [];
    for (const divergence of selected) {
      const source = matrix.source.slice(divergence.span[0], divergence.span[1]);
      const roleSummary = active
        .map((target) => `${target}: ${formatRole(divergence.roles.get(target) ?? 'none')}`)
        .join('; ');
      const finding = makeFinding(this, ctx, {
        message: `Target parses assign different structural roles to \`${source}\` (${roleSummary})`,
        span: divergence.span,
        affectedTargets: active,
        fix: {
          ruleId: this.id,
          safety: 'manual',
          description: 'rewrite with syntax that has the same command graph on every target',
        },
      });
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};

function collectGraphFeatures(
  node: ScriptNode,
  target: ParseTarget,
  features: GraphFeature[] = [],
): GraphFeature[] {
  switch (node.kind) {
    case 'command':
      node.leadingEnv.forEach((assignment) => {
        features.push({ role: 'leading-env', span: assignment.span });
      });
      node.argv.forEach((token, index) => {
        features.push({ role: index === 0 ? 'executable' : 'argument', span: token.span });
      });
      node.redirects.forEach((redirect) => {
        features.push({ role: `redirection-op:${redirect.op}`, span: redirect.span });
        if (redirect.target !== null) {
          features.push({ role: 'redirection-target', span: redirect.target.span });
        }
      });
      return features;
    case 'group':
      return collectGraphFeatures(node.body, target, features);
    case 'sequence':
      node.opSpans.forEach((span, index) => {
        const op = node.ops[index];
        const role = op === '&' ? `sequence:&:${target}` : `sequence:${op ?? ''}`;
        features.push({ role, span });
      });
      break;
    case 'boolean':
      node.opSpans.forEach((span, index) => {
        features.push({ role: `boolean:${node.ops[index] ?? ''}`, span });
      });
      break;
    case 'pipeline':
      node.opSpans.forEach((span) => {
        features.push({ role: 'pipeline:|', span });
      });
      break;
    case 'case':
    case 'compound':
      break;
  }
  for (const part of node.parts) collectGraphFeatures(part, target, features);
  return features;
}

function graphDivergences(
  source: string,
  active: readonly ParseTarget[],
  byTarget: ReadonlyMap<ParseTarget, readonly GraphFeature[]>,
): Divergence[] {
  const boundaries = new Set<number>();
  for (const features of byTarget.values()) {
    for (const feature of features) {
      boundaries.add(feature.span[0]);
      boundaries.add(feature.span[1]);
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const divergences: Divergence[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (start === undefined || end === undefined || start === end) continue;
    if (/^\s+$/.test(source.slice(start, end))) continue;
    const roles = new Map<ParseTarget, string>();
    for (const target of active) {
      roles.set(target, roleAt(byTarget.get(target) ?? [], start, end));
    }
    if (new Set(roles.values()).size < 2) continue;
    if (![...roles.values()].some(isStructuralRole)) continue;
    divergences.push({ span: [start, end], roles });
  }
  return divergences;
}

function roleAt(features: readonly GraphFeature[], start: number, end: number): string {
  const candidates = features.filter(
    (feature) => feature.span[0] <= start && end <= feature.span[1],
  );
  candidates.sort(
    (left, right) =>
      rolePriority(left.role) - rolePriority(right.role) ||
      left.span[1] - left.span[0] - (right.span[1] - right.span[0]),
  );
  return candidates[0]?.role ?? 'none';
}

function rolePriority(role: string): number {
  if (isOperatorRole(role)) return 0;
  if (role === 'executable') return 1;
  if (role === 'redirection-target') return 2;
  if (role === 'leading-env') return 3;
  return 4;
}

function isOperatorRole(role: string): boolean {
  return /^(sequence|boolean|pipeline|redirection-op):/.test(role);
}

function isStructuralRole(role: string): boolean {
  return isOperatorRole(role) || role === 'executable' || role === 'redirection-target';
}

function formatRole(role: string): string {
  return role.replaceAll('-', ' ').replaceAll(':', ' ');
}
