/**
 * PS010 — POSIX_RM: `rm` (and `rm -rf`) does not exist in native Windows
 * npm scripts (cmd.exe).
 */
import { rimrafFix, shxPrefixFix } from './fix-builders';
import type { RuleModule } from './types';
import { availabilityRule } from './util';

export const PS010: RuleModule = availabilityRule(
  {
    id: 'PS010',
    title: 'POSIX_RM',
    summary: '`rm` / `rm -rf` is not available in native Windows npm scripts.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['rm -rf dist', 'rm -r build', 'rm temp.log'],
    goodExamples: [
      'rimraf dist',
      'shx rm -rf dist',
      "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    ],
    falsePositiveNotes:
      'Not reported for `rimraf …` or `shx rm …` (command position is the tool), nor for rm inside strings or shell-wrapper payloads.',
    fixSafety: 'conditional',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/windows-commands',
        claim: 'cmd.exe has del/rmdir, not rm; `rm -rf dist` fails with "rm is not recognized".',
      },
      {
        source: 'https://github.com/isaacs/rimraf#readme',
        claim: 'rimraf provides a cross-platform rm -rf equivalent for Node projects.',
      },
    ],
  },
  {
    names: new Set(['rm']),
    message: (cmd) =>
      `\`${cmd.raw.split(' ').slice(0, 2).join(' ')}\` is not available in native Windows npm scripts`,
    fixSummary: 'use rimraf (devDependency), shx rm, or Node fs.rm',
    fix: (cmd, ctx) => rimrafFix(cmd, ctx),
  },
);
