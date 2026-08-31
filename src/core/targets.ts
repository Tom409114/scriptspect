/**
 * Target shell resolution: CLI `--target`, config `targets`, and the default
 * matrix (npm's actual script shells: `sh` on macOS/Linux, `cmd.exe` on
 * Windows). PowerShell joins only when explicitly declared.
 */
import type { ShellTarget } from '../parser/ir';

export const ALL_TARGETS: readonly ShellTarget[] = ['posix-sh', 'cmd', 'powershell'];

/** npm's default script shells on the platforms contributors actually use. */
export const DEFAULT_TARGETS: readonly ShellTarget[] = ['posix-sh', 'cmd'];

export function parseTargets(value: string | undefined): ShellTarget[] | null {
  if (value === undefined || value.trim() === '') return null;
  const targets: ShellTarget[] = [];
  for (const part of value.split(',')) {
    const t = part.trim().toLowerCase();
    if (t === '') continue;
    const match = ALL_TARGETS.find((c) => c === t);
    if (match === undefined) return null; // invalid target: config error territory
    if (!targets.includes(match)) targets.push(match);
  }
  return targets.length > 0 ? targets : null;
}

export function intersectTargets(
  affected: readonly ShellTarget[],
  active: readonly ShellTarget[],
): ShellTarget[] {
  return affected.filter((t) => active.includes(t));
}
