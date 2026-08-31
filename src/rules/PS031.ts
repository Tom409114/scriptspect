/**
 * PS031 — EXPLICIT_CMD: `cmd /c …` makes the script unusable on macOS/Linux.
 */

import type { RuleModule } from './types';
import { availabilityRule } from './util';

const CMD_NAMES = new Set(['cmd', 'cmd.exe']);

export const PS031: RuleModule = availabilityRule(
  {
    id: 'PS031',
    title: 'EXPLICIT_CMD',
    summary: '`cmd /c …` ties the script to Windows and fails on macOS/Linux.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['posix-sh'],
    badExamples: ['cmd /c "set FOO=bar&& node app.js"', 'cmd /c dir'],
    goodExamples: ['node app.js', 'ls'],
    falsePositiveNotes:
      'Wrapper payloads are never re-analyzed. Intentional Windows-only scripts should be suppressed via config, not restructured by the linter.',
    fixSafety: 'manual',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd',
        claim: 'cmd.exe is the Windows command interpreter; it does not exist on macOS/Linux.',
      },
    ],
  },
  {
    names: CMD_NAMES,
    message: (cmd) => `\`${cmd.argv[0]?.raw ?? ''}\` is Windows-only and fails on macOS/Linux`,
    fixSummary:
      'replace with cross-platform logic or move the Windows-specific part to a platform-scoped script',
  },
);
