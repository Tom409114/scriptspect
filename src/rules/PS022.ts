/**
 * PS022 — POSIX_SOURCE: `source` / `.` dot-sourcing requires a POSIX shell.
 */

import type { CommandNode } from '../parser/ir';
import type { RuleModule } from './types';
import { availabilityRule } from './util';

function isSourceInvocation(cmd: CommandNode): boolean {
  const name = cmd.argv[0]?.value ?? '';
  return name === 'source' || (name === '.' && cmd.argv.length > 1);
}

export const PS022: RuleModule = availabilityRule(
  {
    id: 'PS022',
    title: 'POSIX_SOURCE',
    summary: '`source` (or `.`) requires a POSIX shell and fails under cmd.exe.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd', 'powershell'],
    badExamples: ['source ./env.sh', '. ./scripts/env.sh'],
    goodExamples: ['node -r dotenv/config app.js', 'bash ./env.sh'],
    falsePositiveNotes:
      'Only the dot form with a following argument counts; a bare `.` is not a source command.',
    fixSafety: 'manual',
    provenance: [
      {
        source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#dot',
        claim:
          '`.` (dot) executes a file in the current shell — POSIX builtin; source is the bash synonym.',
      },
    ],
  },
  {
    names: new Set(['source', '.']),
    matches: isSourceInvocation,
    message: () => '`source`/`.` dot-sourcing requires a POSIX shell',
    fixSummary: 'move environment setup into Node (dotenv) or an explicit shell wrapper',
  },
);
