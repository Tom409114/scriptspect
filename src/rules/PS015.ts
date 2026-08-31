/**
 * PS015 — POSIX_CHMOD: `chmod` has no equivalent permission semantics on
 * Windows (neither cmd.exe nor PowerShell).
 */

import type { RuleModule } from './types';
import { availabilityRule } from './util';

export const PS015: RuleModule = availabilityRule(
  {
    id: 'PS015',
    title: 'POSIX_CHMOD',
    summary: 'chmod permission bits have no Windows equivalent; avoid relying on chmod in scripts.',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['cmd', 'powershell'],
    badExamples: ['chmod +x scripts/deploy.sh', 'chmod 755 build'],
    goodExamples: ['node scripts/deploy.js', 'deploy-now --target production'],
    falsePositiveNotes:
      'Legitimate inside explicit bash wrappers (not re-analyzed). Postinstall use of chmod for optionalDependencies executables is a known pattern — suppress via config when intentional.',
    fixSafety: 'manual',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls',
        claim:
          'Windows ACLs (icacls) differ fundamentally from POSIX mode bits; there is no chmod.',
      },
    ],
  },
  {
    names: new Set(['chmod']),
    message: (cmd) =>
      `\`${cmd.argv[0]?.raw ?? 'chmod'}\` has no equivalent permission semantics on Windows`,
    fixSummary:
      'avoid chmod in lifecycle scripts; set executability in packaging (e.g. npm bin) instead',
  },
);
