/**
 * PS025 — DEV_NULL: `/dev/null` does not exist on Windows (`NUL` there).
 */
import { makeFinding } from '../core/finding';
import { commandsOf } from './util';
import type { Finding, RuleContext, RuleModule } from './types';

export const PS025: RuleModule = {
  id: 'PS025',
  title: 'DEV_NULL',
  summary: 'Redirecting to /dev/null fails on Windows (the device is NUL).',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['cmd', 'powershell'],
  badExamples: ['node heavy.js > /dev/null', 'cmd 2> /dev/null'],
  goodExamples: ['node scripts/quiet.js', 'node heavy.js > build.log'],
  falsePositiveNotes: 'Only tokens equal to /dev/null (or a /dev/null path suffix) match; documentation strings mentioning /dev/null inside larger quoted prose are still reported — suppress via config if intentional.',
  fixSafety: 'manual',
  provenance: [
    {
      source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/microsoft-windows-commands',
      claim: 'Windows null device is NUL; /dev/null does not resolve.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const check = (value: string, span: [number, number]): void => {
      if (!value.includes('/dev/null')) return;
      const finding = makeFinding(this, ctx, {
        message: '`/dev/null` does not exist on Windows (the null device is `NUL`)',
        span,
        fix: {
          ruleId: this.id,
          safety: 'manual',
          description: 'use a cross-platform redirection strategy (Node wrapper or per-shell scripts)',
        },
      });
      if (finding !== null) findings.push(finding);
    };
    for (const cmd of commandsOf(ir)) {
      for (const tok of cmd.argv) check(tok.value, tok.span);
      for (const red of cmd.redirects) {
        if (red.target !== null) check(red.target.value, red.target.span);
      }
    }
    return findings;
  },
};
