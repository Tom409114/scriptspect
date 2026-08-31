/**
 * GitHub Actions reporter: `::error/warning/notice file=…,title=…::…`
 * workflow annotations for every finding, plus a job summary appended to
 * $GITHUB_STEP_SUMMARY (packages/scripts scanned, error/warning counts,
 * top rules). Annotations degrade to file + script name when a precise
 * JSON position cannot be mapped (spec §12.1).
 */
import type { Finding } from '../rules/types';
import type { AnalysisResult } from '../core/analyze';
import { appendFileSync } from 'node:fs';

function annotationLevel(severity: Finding['severity']): 'error' | 'warning' | 'notice' {
  if (severity === 'error') return 'error';
  if (severity === 'warn') return 'warning';
  return 'notice';
}

/** Percent-encode characters that break the annotation message format. */
function escapeData(s: string): string {
  return s.replace(/[\r\n]/g, ' ').replace(/[%]/g, '%25').replace(/[:]/g, '%3A').replace(/[,]/g, '%2C');
}

function escapeProperty(s: string): string {
  return s.replace(/[\r\n]/g, ' ').replace(/[%]/g, '%25').replace(/[:]/g, '%3A').replace(/[,]/g, '%2C');
}

export function renderAnnotations(result: AnalysisResult): string {
  return result.findings
    .map((f) => {
      const level = annotationLevel(f.severity);
      const file = escapeProperty(f.packagePath);
      const title = escapeProperty(`${f.ruleId}: scripts.${f.scriptName}`);
      const message = escapeData(
        `${f.message} · affected: ${f.affectedTargets.join(', ')} · scripts.${f.scriptName}`,
      );
      return `::${level} file=${file},title=${title}::${message}`;
    })
    .join('\n');
}

/** Markdown job summary (spec §12.1: scanned counts, errors/warnings, top rules). */
export function renderSummary(result: AnalysisResult): string {
  const s = result.summary;
  const byRule = new Map<string, number>();
  for (const f of result.findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  const topRules = [...byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);

  const lines = [
    '## scriptspect',
    '',
    `Scanned **${s.scriptsScanned} script${s.scriptsScanned === 1 ? '' : 's'}** across **${s.packagesScanned} package${s.packagesScanned === 1 ? '' : 's'}**.`,
    '',
    `| Severity | Count |`,
    `| --- | --- |`,
    `| errors | ${s.errors} |`,
    `| warnings | ${s.warnings} |`,
    `| advisories | ${s.advisories} |`,
  ];
  if (topRules.length > 0) {
    lines.push('', '**Top rules**', '', '| Rule | Findings |', '| --- | --- |');
    for (const [ruleId, count] of topRules) lines.push(`| ${ruleId} | ${count} |`);
  }
  return lines.join('\n');
}

/** Append the job summary to $GITHUB_STEP_SUMMARY when running in Actions. */
export function writeJobSummary(result: AnalysisResult): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, `${renderSummary(result)}\n`);
  } catch {
    // summary is best-effort; never fail the run for it
  }
}
