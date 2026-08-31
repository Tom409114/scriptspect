/**
 * PS024 — CMD_VAR_EXPANSION: `%VAR%` is cmd.exe-specific; POSIX sh passes it
 * through literally.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

export const PS024: RuleModule = {
  id: 'PS024',
  title: 'CMD_VAR_EXPANSION',
  summary: '`%VAR%` expansion is cmd.exe-specific and stays literal in POSIX sh.',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['posix-sh'],
  badExamples: ['echo %APPDATA%', 'mkdir "%USERPROFILE%\\build"'],
  goodExamples: ['echo $HOME', 'node -e "console.log(process.env.USERPROFILE)"'],
  falsePositiveNotes:
    'Format strings without a closing percent (printf "%s\\n", date +%Y) never match. cmd-style FOR variables (%%i) are out of scope for v0.1.',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1',
      claim: 'cmd.exe expands %VAR%.',
    },
    {
      source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html',
      claim: 'POSIX sh treats % as a literal character.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      for (const tok of cmd.argv) {
        for (const exp of tok.expansions) {
          if (exp.kind !== 'cmdvar') continue;
          const finding = makeFinding(this, ctx, {
            message: `\`${exp.raw}\` is cmd.exe-specific; POSIX sh leaves it literal`,
            span: exp.span,
            fix: {
              ruleId: this.id,
              safety: 'manual',
              description: 'read the variable in Node (process.env) or use per-shell scripts',
            },
          });
          if (finding !== null) findings.push(finding);
        }
      }
    }
    return findings;
  },
};
