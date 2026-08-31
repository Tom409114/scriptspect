/**
 * PS013 — POSIX_MKDIR_P: `mkdir -p` (create parents, ok if exists) has no
 * equivalent flag form under cmd.exe.
 */

import type { CommandNode } from '../parser/ir';
import type { RuleModule } from './types';
import { availabilityRule, flagsOf } from './util';

function hasParentsFlag(cmd: CommandNode): boolean {
  return flagsOf(cmd).some(
    (f) => f === '-p' || f === '--parents' || (/^-[a-zA-Z]{1,4}$/.test(f) && f.includes('p')),
  );
}

export const PS013: RuleModule = availabilityRule(
  {
    id: 'PS013',
    title: 'POSIX_MKDIR_P',
    summary: '`mkdir -p` semantics (create parents, ignore existing) do not carry over to cmd.exe.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['mkdir -p dist/assets', 'mkdir -p a/b/c'],
    goodExamples: [
      'shx mkdir -p dist/assets',
      "node -e \"require('fs').mkdirSync('a/b/c',{recursive:true})\"",
    ],
    falsePositiveNotes:
      'Plain `mkdir` (no -p/--parents) is not reported: cmd.exe has mkdir and `mkdir a\\b` creates parents. Only the flag form differs.',
    fixSafety: 'conditional',
    provenance: [
      {
        source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/mkdir.html',
        claim: 'POSIX -p creates missing parents and does not error when the directory exists.',
      },
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/mkdir',
        claim: 'cmd.exe mkdir errors when the directory already exists and has no -p flag.',
      },
    ],
  },
  {
    names: new Set(['mkdir']),
    matches: hasParentsFlag,
    message: (cmd) =>
      `\`${cmd.argv[0]?.raw ?? 'mkdir'} ${flagsOf(cmd).join(' ')}\` is not portable to cmd.exe`,
    fixSummary: 'use shx mkdir -p or Node fs.mkdir recursive',
  },
);
