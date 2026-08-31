/**
 * PS012 — POSIX_MV: `mv` does not exist under cmd.exe.
 */
import { shxPrefixFix } from './fix-builders';
import type { RuleModule } from './types';
import { availabilityRule } from './util';

export const PS012: RuleModule = availabilityRule(
  {
    id: 'PS012',
    title: 'POSIX_MV',
    summary: '`mv` is not available in native Windows npm scripts.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['mv dist build', 'mv old.json new.json'],
    goodExamples: ['shx mv dist build', "node -e \"require('fs').renameSync('a','b')\""],
    falsePositiveNotes: 'Not reported for `shx mv …` or mv inside strings/wrapper payloads.',
    fixSafety: 'conditional',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/move',
        claim: 'cmd.exe uses move; `mv` is not recognized.',
      },
    ],
  },
  {
    names: new Set(['mv']),
    message: () => '`mv` is not available in native Windows npm scripts',
    fixSummary: 'use shx mv or Node fs.rename',
    fix: (cmd, ctx) => shxPrefixFix('PS012', cmd, ctx),
  },
);
