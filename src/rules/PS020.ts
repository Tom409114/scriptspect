/**
 * PS020 — COMMAND_SUBSTITUTION: `$(…)` is POSIX command substitution; cmd.exe
 * cannot execute it.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

export const PS020: RuleModule = {
  id: 'PS020',
  title: 'COMMAND_SUBSTITUTION',
  summary: '`$(…)` command substitution is POSIX-only and fails under cmd.exe.',
  severity: 'error',
  confidence: 'high',
  affectedTargets: ['cmd'],
  badExamples: ['node $(npm bin)/jest', 'echo "built at $(date)"', 'rm -rf $(ls dist)'],
  goodExamples: ['npx jest', 'node scripts/run.js'],
  falsePositiveNotes:
    'Not reported inside explicit shell wrappers (PS030 owns those), and substitution contents are not scanned for other rules (no double reporting).',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_06_03',
      claim: '$( ) command substitution is defined by POSIX shell.',
    },
    {
      source:
        'https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc772390(v=ws.11)',
      claim: 'cmd.exe has no command substitution; it uses for /f with delayed expansion at best.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      const tokens = [
        ...cmd.argv,
        ...cmd.redirects.flatMap((r) => (r.target !== null ? [r.target] : [])),
      ];
      for (const tok of tokens) {
        for (const exp of tok.expansions) {
          if (exp.kind !== 'command') continue;
          const finding = makeFinding(this, ctx, {
            message: `\`${exp.raw}\` is POSIX command substitution; cmd.exe cannot run it`,
            span: exp.span,
            fix: {
              ruleId: this.id,
              safety: 'manual',
              description:
                'compute the value in a Node helper or run the step inside an explicit shell',
            },
          });
          if (finding !== null) findings.push(finding);
        }
      }
    }
    return findings;
  },
};
