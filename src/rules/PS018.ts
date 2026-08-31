/**
 * PS018 — POSIX_SED: `sed` does not exist under cmd.exe.
 */
import { rimrafFix, shxPrefixFix } from './fix-builders';
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS018: RuleModule = availabilityRule(
  {
    id: 'PS018',
    title: 'POSIX_SED',
    summary: '`sed` is not available in native Windows npm scripts.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ["sed -i 's/foo/bar/' file.txt", "sed 's/a/b/g' x > y"],
    goodExamples: ['node scripts/replace.js', 'shx sed "s/a/b/g" x'],
    falsePositiveNotes: 'Not reported for `shx sed …` or sed inside strings/wrapper payloads.',
    fixSafety: 'conditional',
    provenance: [
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/windows-commands',
        claim: 'cmd.exe ships no sed equivalent.',
      },
    ],
  },
  {
    names: new Set(['sed']),
    message: () => '`sed` is not available in native Windows npm scripts',
    fixSummary: 'move the transformation into a Node script or use shx sed',
    fix: (cmd, ctx) => shxPrefixFix('PS018', cmd, ctx),
  },
);
