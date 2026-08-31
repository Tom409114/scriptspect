/**
 * PS021 — POSIX_EXPORT: `export` is a POSIX shell builtin; cmd.exe uses `set`.
 */
import { availabilityRule } from './util';
import type { RuleModule } from './types';

export const PS021: RuleModule = availabilityRule(
  {
    id: 'PS021',
    title: 'POSIX_EXPORT',
    summary: '`export` is a POSIX shell builtin and fails under cmd.exe.',
    severity: 'error',
    confidence: 'high',
    affectedTargets: ['cmd'],
    badExamples: ['export NODE_ENV=production', 'export PATH=$PATH:./bin'],
    goodExamples: ['cross-env NODE_ENV=production node app.js', 'node run-with-env.js'],
    falsePositiveNotes: 'Not reported inside explicit shell wrappers.',
    fixSafety: 'conditional',
    provenance: [
      {
        source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#export',
        claim: 'export marks variables for the environment — a POSIX builtin.',
      },
      {
        source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1',
        claim: 'cmd.exe uses `set` to define session variables; `export` is not recognized.',
      },
    ],
  },
  {
    names: new Set(['export']),
    message: () => '`export` is a POSIX shell builtin with no cmd.exe equivalent',
    fixSummary: 'use cross-env per command, or set the variable in a Node wrapper',
  },
);
