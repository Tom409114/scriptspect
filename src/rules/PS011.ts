/**
 * PS011 — POSIX_CP: `cp` / `cp -r` does not exist under cmd.exe.
 */
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS011: RuleModule = availabilityRule(
  {
    id: 'PS011',
    title: 'POSIX_CP',
    summary: '`cp` / `cp -r` is not available in native Windows npm scripts.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['cp -r src dist', 'cp a.txt b.txt'],
    goodExamples: ['shx cp -r src dist', 'node -e "require(\'fs\').cpSync(\'src\',\'dist\',{recursive:true})"'],
    falsePositiveNotes: 'Not reported for `shx cp …` or cp inside strings/wrapper payloads.',
    fixSafety: 'conditional',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/copy',
        claim: 'cmd.exe uses copy/xcopy/robocopy; `cp` is not recognized.',
      },
    ],
  },
  {
    names: new Set(['cp']),
    message: (cmd) => `\`${cmd.argv[0]?.raw ?? 'cp'}\` is not available in native Windows npm scripts`,
    fixSummary: 'use shx cp or Node fs.cp',
  },
);
