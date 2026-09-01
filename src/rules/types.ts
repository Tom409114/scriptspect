/**
 * Rule engine types: metadata contract, findings, and the per-script context
 * rules analyze. All metadata fields are required (docs/contributing-rules.md).
 */
import type { ParseMatrix, ScriptNode, ShellTarget } from '../parser/ir';

export type Severity = 'error' | 'warn' | 'advisory';
export type Confidence = 'high' | 'medium';
export type FixSafety = 'safe' | 'conditional' | 'manual';

export interface Provenance {
  /** URL or citation backing the shell-behavior claim. */
  source: string;
  claim: string;
}

export interface FixCandidate {
  ruleId: string;
  safety: FixSafety;
  description: string;
  /** Text replacement in script-string coordinates (an insertion is a zero-length span). */
  replacement?: { span: [number, number]; text: string };
  /** Dependency that must already be installed before a conditional fix applies. */
  requiresDependency?: string;
}

export interface Finding {
  ruleId: string;
  scriptName: string;
  packagePath: string;
  span: [number, number];
  severity: Severity;
  confidence: Confidence;
  /** Shells this finding breaks, intersected with the active targets. */
  affectedTargets: ShellTarget[];
  message: string;
  /** Stable parser/rule subtype used for deterministic evidence merging. */
  subtype?: string;
  fix?: FixCandidate;
}

export interface RuleContext {
  /** Raw script string; all spans index into this. */
  script: string;
  scriptName: string;
  packagePath: string;
  /** Active target shells for this run. */
  targets: readonly ShellTarget[];
  /** Locally provable dependency provider identities for executable checks. */
  dependencies: ReadonlySet<string>;
  /** Real bin names exposed by workspace dependencies visible to this package. */
  workspaceBins: ReadonlySet<string>;
}

export interface RuleMetadata {
  id: string;
  title: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  /** Shells the pattern breaks (before intersecting with active targets). */
  affectedTargets: readonly ShellTarget[];
  badExamples: string[];
  goodExamples: string[];
  falsePositiveNotes: string;
  fixSafety: FixSafety;
  provenance: Provenance[];
}

export interface RuleModule extends RuleMetadata {
  /** Factory-derived marker for fixes that may rewrite a command invocation. */
  automaticReplacementKind?: 'command';
  check(matrix: ParseMatrix, ctx: RuleContext): Finding[];
}

/** Utilities every rule receives for walking the IR. */
export type Walker = {
  walkCommands(node: ScriptNode): Generator<import('../parser/ir').CommandNode>;
};
