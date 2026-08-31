/**
 * PS026 — UNIX_PATH_ASSUMPTION: hardcoded Unix paths (/tmp, /usr/bin, …)
 * rarely exist on Windows.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

const UNIX_PATH_PREFIXES = [
  '/tmp',
  '/usr',
  '/var',
  '/etc',
  '/opt',
  '/home',
  '/bin',
  '/sbin',
  '/lib',
];

export const PS026: RuleModule = {
  id: 'PS026',
  title: 'UNIX_PATH_ASSUMPTION',
  summary: 'Hardcoded Unix paths (/tmp, /usr/bin, …) do not exist on Windows.',
  severity: 'advisory',
  confidence: 'medium',
  affectedTargets: ['cmd', 'powershell'],
  badExamples: ['cp x /tmp/', 'mkdir /usr/local/etc/app'],
  goodExamples: ['mktemp -d', 'node scripts/tmpdir.js'],
  falsePositiveNotes:
    'Advisory only: absolute Unix paths are occasionally passed as opaque arguments to tools that interpret them elsewhere. Paths like /api used as URLs must not match (they do not: prefix list covers filesystem roots only).',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables',
      claim: 'Windows has no /tmp or /usr; equivalents live under %TEMP%, %ProgramFiles%.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      for (const tok of cmd.argv) {
        const value = tok.value;
        const hit = UNIX_PATH_PREFIXES.find((p) => value === p || value.startsWith(`${p}/`));
        if (hit === undefined) continue;
        const finding = makeFinding(this, ctx, {
          message: `\`${value}\` assumes a Unix filesystem layout`,
          span: tok.span,
          fix: {
            ruleId: this.id,
            safety: 'manual',
            description: 'use os.tmpdir()/PATH lookup in a Node helper instead of hardcoded paths',
          },
        });
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
