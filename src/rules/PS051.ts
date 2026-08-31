/** PS051 — TARGET_SHELL_PARSE_ERROR: active-target parser diagnostics. */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';

export const PS051: RuleModule = {
  id: 'PS051',
  title: 'TARGET_SHELL_PARSE_ERROR',
  summary: 'The script is invalid or outside the supported analyzer subset for an active shell.',
  severity: 'advisory',
  confidence: 'medium',
  affectedTargets: ['posix-sh', 'cmd', 'powershell'],
  badExamples: ["echo 'unterminated", 'echo ${UNTERMINATED'],
  goodExamples: ['echo "complete"', 'node scripts/build.js'],
  falsePositiveNotes:
    'Deterministic syntax failures are error/high. Supported-subset boundaries are advisory/medium and conservatively gate automatic replacements.',
  fixSafety: 'manual',
  provenance: [
    {
      source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html',
      claim:
        'Shell quoting, grouping, expansion, and redirection syntax must be structurally complete.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const target of matrix.activeTargets) {
      const parsed = matrix.byTarget.get(target);
      if (parsed === undefined) continue;
      for (const diagnostic of parsed.diagnostics) {
        const finding = makeFinding(
          this,
          { ...ctx, targets: [target] },
          {
            message: diagnostic.message,
            span: diagnostic.span,
            affectedTargets: [target],
            severity: diagnostic.severity === 'error' ? 'error' : 'advisory',
            confidence: diagnostic.severity === 'error' ? 'high' : 'medium',
            subtype: diagnostic.code,
          },
        );
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
