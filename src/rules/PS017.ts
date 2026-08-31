/**
 * PS017 — POSIX_GREP: `grep` does not exist under cmd.exe.
 */
import { rimrafFix, shxPrefixFix } from './fix-builders';
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS017: RuleModule = availabilityRule(
  {
    id: 'PS017',
    title: 'POSIX_GREP',
    summary: '`grep` is not available in native Windows npm scripts.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['grep -r "TODO" src', 'cat x | grep y'],
    goodExamples: ['shx grep -r "TODO" src', 'node scripts/search.js'],
    falsePositiveNotes: 'Not reported for `shx grep …` or grep inside strings/wrapper payloads.',
    fixSafety: 'conditional',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/findstr',
        claim: 'cmd.exe ships findstr, not grep.',
      },
    ],
  },
  {
    names: new Set(['grep']),
    message: () => '`grep` is not available in native Windows npm scripts (findstr differs)',
    fixSummary: 'use shx grep or a Node implementation',
    fix: (cmd, ctx) => shxPrefixFix('PS017', cmd, ctx),
  },
);
