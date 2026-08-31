/**
 * PS050 — SHELL_SPECIFIC_SEPARATOR: `;` and single `&` mean different things
 * (or nothing) across sh and cmd.exe. Advisory only: `&&`, `||`, and `|` are
 * fine on both and never reported.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { collectSequenceOps } from './util';

export const PS050: RuleModule = {
  id: 'PS050',
  title: 'SHELL_SPECIFIC_SEPARATOR',
  summary: '`;` and `&` separators have different semantics in sh and cmd.exe.',
  severity: 'advisory',
  confidence: 'medium',
  affectedTargets: ['cmd', 'posix-sh'],
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
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const { op, span } of collectSequenceOps(ir.root)) {
      if (op === ';') {
        const finding = makeFinding(this, ctx, {
          message:
            '`;` separates commands in POSIX sh but not in cmd.exe (use `&&` or a runner like run-s)',
          span,
          affectedTargets: ['cmd'],
          fix: { ruleId: this.id, safety: 'manual', description: 'replace with && or npm-run-all' },
        });
        if (finding !== null) findings.push(finding);
      } else if (op === '&') {
        const finding = makeFinding(this, ctx, {
          message:
            'single `&` backgrounds a command in POSIX sh but sequences in cmd.exe — semantics differ',
          span,
          affectedTargets: ['posix-sh', 'cmd'],
          fix: {
            ruleId: this.id,
            safety: 'manual',
            description: 'use && for sequencing or a task runner',
          },
        });
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
