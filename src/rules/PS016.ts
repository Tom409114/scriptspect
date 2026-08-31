/**
 * PS016 — POSIX_WHICH: `which` does not exist under cmd.exe (it uses `where`).
 */
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS016: RuleModule = availabilityRule(
  {
    id: 'PS016',
    title: 'POSIX_WHICH',
    summary: '`which` is not available in native Windows npm scripts (cmd.exe uses `where`).',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['which node', 'which python3'],
    goodExamples: [
      'node -e "console.log(process.execPath)"',
      'npx which-node',
    ],
    falsePositiveNotes: 'PowerShell users often alias which; the default npm script shell on Windows is cmd.exe, which has where.exe only.',
    fixSafety: 'manual',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/where',
        claim: 'cmd.exe ships where.exe; there is no which.',
      },
    ],
  },
  {
    names: new Set(['which']),
    message: () => '`which` is not available in native Windows npm scripts (use `where` or Node lookups)',
    fixSummary: 'use where on Windows, a cross-platform lookup package, or Node resolution',
  },
);
