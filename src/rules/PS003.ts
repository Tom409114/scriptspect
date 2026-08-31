/**
 * PS003 — POWERSHELL_ENV: `$env:FOO='bar'` is PowerShell-specific syntax.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

const PS_ENV_RE = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/;

export const PS003: RuleModule = {
  id: 'PS003',
  title: 'POWERSHELL_ENV',
  summary: '`$env:NAME=…` assignment syntax exists only in PowerShell.',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['posix-sh', 'cmd'],
  badExamples: ["$env:NODE_ENV='production'; node app.js", "$env:PATH='…'; npm test"],
  goodExamples: [
    'cross-env NODE_ENV=production node app.js',
    'powershell -Command "$env:X=1; node app.js"',
  ],
  falsePositiveNotes:
    'Not reported inside explicit powershell/pwsh wrappers (the dependency itself is reported by PS032 instead).',
  fixSafety: 'conditional',
  provenance: [
    {
      source:
        'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_Environment_Variables',
      claim: '$env:NAME is the PowerShell provider syntax for environment variables.',
    },
    {
      source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html',
      claim: 'POSIX sh and cmd.exe have no $env: namespace; the text is passed through literally.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(matrix, 'powershell')) {
      if (cmd.wrapper?.shell === 'powershell') continue;
      for (const tok of cmd.argv) {
        if (!PS_ENV_RE.test(tok.value)) continue;
        const finding = makeFinding(this, ctx, {
          message: `\`${tok.raw.split('=')[0]}=…\` is PowerShell-only env syntax`,
          span: tok.span,
          fix: {
            ruleId: this.id,
            safety: 'conditional',
            description: 'use cross-env, or keep the syntax inside an explicit powershell wrapper',
            requiresDependency: 'cross-env',
          },
        });
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
