/**
 * PS014 — POSIX_TOUCH: `touch` does not exist under cmd.exe.
 */
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS014: RuleModule = availabilityRule(
  {
    id: 'PS014',
    title: 'POSIX_TOUCH',
    summary: '`touch` is not available in native Windows npm scripts.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['touch build.timestamp', 'touch src/generated.ts'],
    goodExamples: ['node scripts/make-marker.js', 'echo ok > build.timestamp'],
    falsePositiveNotes: 'Not reported inside strings or shell-wrapper payloads.',
    fixSafety: 'manual',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/windows-commands',
        claim: 'cmd.exe has no touch; typical workarounds are `type nul > file` or copy nul.',
      },
    ],
  },
  {
    names: new Set(['touch']),
    message: () => '`touch` is not available in native Windows npm scripts',
    fixSummary: 'create the file from Node or a cross-platform package',
  },
);
