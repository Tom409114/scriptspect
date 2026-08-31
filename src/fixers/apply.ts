/**
 * Fix application engine (spec §7).
 *
 * Safety model:
 * - `safe`      — no new dependency, locally provable; applied by --fix
 * - `conditional` — requires a verified precondition (e.g. the replacement
 *   tool is already a devDependency); applied by --fix only when met,
 *   otherwise surfaced as a plan
 * - `manual`    — explained only, never applied
 *
 * Rules emit `fix.replacement` ONLY when the precondition is already
 * satisfied (a missing dependency yields `requiresDependency` and no
 * replacement), so applicability here reduces to "a replacement exists".
 * Replacements apply right-to-left so earlier spans stay valid; overlapping
 * replacements never double-apply. Idempotency: every rewrite removes the
 * pattern its rule matches, so re-analysis finds nothing left to fix.
 */
import type { Finding } from '../rules/types';

export interface AppliedFix {
  ruleId: string;
  scriptName: string;
  packagePath: string;
  before: string;
  after: string;
}

export interface ApplyResult {
  /** The rewritten script string (identical when nothing applied). */
  script: string;
  applied: AppliedFix[];
  /** Findings that carried a plan but no applicable replacement. */
  planned: Finding[];
}

/** All fixes that are applicable right now (replacement present). */
export function applicableFixes(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.fix?.replacement !== undefined);
}

/** Apply fix replacements to one script string. Never throws. */
export function applyToScript(script: string, findings: readonly Finding[]): ApplyResult {
  const candidates = applicableFixes(findings)
    .map((f) => ({ finding: f, rep: f.fix?.replacement }))
    .filter(
      (c): c is { finding: Finding; rep: { span: [number, number]; text: string } } =>
        c.rep !== undefined,
    )
    .sort((x, y) => y.rep.span[0] - x.rep.span[0]);

  let out = script;
  let covered: [number, number] | null = null;
  const applied: AppliedFix[] = [];
  const appliedSpans: Array<[number, number]> = [];

  for (const { finding, rep } of candidates) {
    const [start, end] = rep.span;
    // Overlap guard: skip anything inside an already-replaced region.
    if (covered !== null && start < covered[1] && end > covered[0]) continue;
    const slice = script.slice(Math.max(0, start), Math.max(0, end));
    out = out.slice(0, Math.max(0, start)) + rep.text + out.slice(Math.max(0, end));
    applied.push({
      ruleId: finding.ruleId,
      scriptName: finding.scriptName,
      packagePath: finding.packagePath,
      before: slice,
      after: rep.text,
    });
    appliedSpans.push([start, end]);
    covered =
      covered === null ? [start, end] : [Math.min(covered[0], start), Math.max(covered[1], end)];
  }

  applied.reverse(); // restore source order for reporting
  const appliedSet = new Set(applied.map((a) => `${a.packagePath} ${a.scriptName} ${a.ruleId}`));
  const planned = findings.filter(
    (f) =>
      f.fix !== undefined &&
      f.fix.replacement === undefined &&
      !appliedSet.has(`${f.packagePath} ${f.scriptName} ${f.ruleId}`),
  );

  return { script: out, applied, planned };
}
