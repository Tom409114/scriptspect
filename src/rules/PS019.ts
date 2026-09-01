/**
 * PS019 — POSIX_CAT: `cat` does not exist under cmd.exe (type differs).
 */
import type { RuleModule } from './types';
import { availabilityRule } from './util';

export const PS019: RuleModule = availabilityRule(
  {
    id: 'PS019',
    title: 'POSIX_CAT',
    summary: '`cat` is not available in native Windows npm scripts.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['cat config/base.json > config/local.json', 'cat CHANGELOG.md | head -5'],
    goodExamples: [
      'shx cat config/base.json',
      "node -e \"process.stdout.write(require('fs').readFileSync('f'))\"",
    ],
    falsePositiveNotes:
      'PowerShell has a cat alias, but the default Windows npm script shell is cmd.exe (type). Not reported for `shx cat …`.',
    fixSafety: 'manual',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/type',
        claim: 'cmd.exe uses type; cat is not recognized.',
      },
    ],
  },
  {
    names: new Set(['cat']),
    message: () => '`cat` is not available in native Windows npm scripts',
    fixSummary:
      'manually choose a byte-preserving Node implementation, or shx cat only for proven text files',
  },
);
