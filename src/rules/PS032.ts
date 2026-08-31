/**
 * PS032 — EXPLICIT_POWERSHELL: powershell/pwsh wrappers are shell-specific.
 */

import type { RuleModule } from './types';
import { availabilityRule } from './util';

const PS_NAMES = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

export const PS032: RuleModule = availabilityRule(
  {
    id: 'PS032',
    title: 'EXPLICIT_POWERSHELL',
    summary: 'powershell/pwsh wrappers assume PowerShell exists (missing on stock macOS/Linux).',
    severity: 'warn',
    confidence: 'high',
    affectedTargets: ['posix-sh'],
    badExamples: ['powershell -Command "echo hi"', 'pwsh -File ./build.ps1'],
    goodExamples: ['node ./build.js'],
    falsePositiveNotes:
      'Wrapper payloads are never re-analyzed. macOS can install pwsh, but a stock environment does not ship it.',
    fixSafety: 'manual',
    provenance: [
      {
        source:
          'https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell',
        claim: 'PowerShell is preinstalled on Windows only; macOS/Linux need a manual install.',
      },
    ],
  },
  {
    names: PS_NAMES,
    message: (cmd) =>
      `\`${cmd.argv[0]?.raw ?? ''}\` requires PowerShell, which stock macOS/Linux lacks`,
    fixSummary:
      'declare the dependency explicitly or rewrite the step as cross-platform Node logic',
  },
);
