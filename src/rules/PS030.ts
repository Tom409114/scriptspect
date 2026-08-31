/**
 * PS030 — EXPLICIT_BASH: scripts invoking bash/sh/zsh depend on a shell that
 * default Windows environments do not have.
 */
import { availabilityRule } from './util';
import type { RuleModule } from './types';

const SH_FAMILY = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

export const PS030: RuleModule = availabilityRule(
  {
    id: 'PS030',
    title: 'EXPLICIT_BASH',
    summary: 'Scripts calling bash/sh/zsh depend on a Unix shell that stock Windows lacks.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['bash -c "rm -rf dist"', 'bash scripts/build.sh', 'sh ./deploy.sh'],
    goodExamples: ['node scripts/build.js', 'rimraf dist'],
    falsePositiveNotes:
      'Wrapper payloads are never re-analyzed (no duplicate inner findings). Not reported when bash is an intentional, documented dependency — suppress via config in that case.',
    fixSafety: 'manual',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows/nodejs/beginners-tutorial-to-nodejs',
        claim: 'A stock Windows Node.js install provides cmd.exe/PowerShell; bash requires WSL, Git Bash, or a manual install.',
      },
      {
        source: 'https://docs.npmjs.com/cli/v10/using-npm/scripts',
        claim: 'npm runs scripts with sh on Unix and cmd.exe on Windows by default.',
      },
    ],
  },
  {
    names: SH_FAMILY,
    message: (cmd) =>
      `\`${cmd.argv[0]?.raw ?? ''}\` requires a POSIX shell; default Windows environments have none`,
    fixSummary: 'document the shell dependency, rewrite in Node, or declare it in a platform-specific script',
  },
);
