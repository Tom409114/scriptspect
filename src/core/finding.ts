/**
 * Finding construction helpers shared by all rules.
 */
import type { ShellTarget } from '../parser/ir';
import type {
  Confidence,
  Finding,
  FixCandidate,
  RuleContext,
  RuleMetadata,
  Severity,
} from '../rules/types';
import { intersectTargets } from './targets';

export interface FindingOpts {
  message: string;
  span: [number, number];
  fix?: FixCandidate;
  severity?: Severity;
  confidence?: Confidence;
  affectedTargets?: readonly ShellTarget[];
  subtype?: string;
}

/**
 * Build a finding, dropping it when none of its affected shells are active.
 * Rules never need to filter targets themselves.
 */
export function makeFinding(
  rule: Pick<RuleMetadata, 'id' | 'severity' | 'confidence' | 'affectedTargets'>,
  ctx: RuleContext,
  opts: FindingOpts,
): Finding | null {
  const affected = intersectTargets(opts.affectedTargets ?? rule.affectedTargets, ctx.targets);
  if (affected.length === 0) return null;
  return {
    ruleId: rule.id,
    scriptName: ctx.scriptName,
    packagePath: ctx.packagePath,
    span: opts.span,
    severity: opts.severity ?? rule.severity,
    confidence: opts.confidence ?? rule.confidence,
    affectedTargets: affected,
    message: opts.message,
    subtype: opts.subtype,
    fix: opts.fix,
  };
}

/** Sort findings by span start, then rule id, for deterministic output. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.span[0] - b.span[0] || a.ruleId.localeCompare(b.ruleId));
}
