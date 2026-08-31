/**
 * PS023 — POSIX_VAR_EXPANSION: `$VAR` / `${VAR}` expand in POSIX shells but
 * are literal text under cmd.exe (`%VAR%` there).
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

export const PS023: RuleModule = {
  id: 'PS023',
  title: 'POSIX_VAR_EXPANSION',
  summary: '`$VAR` / `${VAR}` do not expand under cmd.exe (which uses `%VAR%`).',
  severity: 'warn',
  confidence: 'medium',
  affectedTargets: ['cmd'],
  badExamples: ['echo $npm_package_version', 'node build.js --out ${OUT_DIR:-dist}', 'ls $HOME'],
  goodExamples: ['node -e "console.log(process.env.npm_package_version)"', 'npm run print-version'],
  falsePositiveNotes:
    'Medium confidence by design: cmd users may run via a custom script-shell, and npm_* variables are sometimes only needed on Unix. `$env:` forms belong to PS003; `$(…)` to PS020.',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_05_02',
      claim: 'POSIX shells expand $VAR/${VAR}.',
    },
    {
      source:
        'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1',
      claim: 'cmd.exe expands %VAR%; $VAR stays literal.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(matrix, 'posix-sh')) {
      const tokens = [
        ...cmd.argv,
        ...cmd.redirects.flatMap((r) => (r.target !== null ? [r.target] : [])),
      ];
      for (const tok of tokens) {
        if (tok.value.startsWith('$env:')) continue; // PS003
        for (const exp of tok.expansions) {
          if (exp.kind !== 'var' && exp.kind !== 'braced' && exp.kind !== 'special') continue;
          const finding = makeFinding(this, ctx, {
            message: `\`${exp.raw}\` does not expand under cmd.exe (it uses %VAR%)`,
            span: exp.span,
            fix: {
              ruleId: this.id,
              safety: 'manual',
              description: 'use cross-env-shell, a Node wrapper, or per-shell scripts',
            },
          });
          if (finding !== null) findings.push(finding);
        }
      }
    }
    return findings;
  },
};
