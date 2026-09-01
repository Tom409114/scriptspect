/**
 * npm / Yarn / Bun workspace globs from the root package.json `workspaces`
 * field. Supports both forms (array of globs, or `{ packages: [...] }`).
 * These ecosystems share the field; anything they add later lands here via
 * an adapter (spec §8).
 */

import { assertSafeWorkspaceGlobs } from './glob';

export function npmWorkspaceGlobs(workspaces: unknown): string[] {
  if (workspaces === undefined || workspaces === null) return [];
  if (Array.isArray(workspaces)) {
    return assertSafeWorkspaceGlobs(
      workspaces.filter((w): w is string => typeof w === 'string' && w.trim() !== ''),
      'package.json workspaces',
    );
  }
  if (typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return assertSafeWorkspaceGlobs(
        packages.filter((w): w is string => typeof w === 'string' && w.trim() !== ''),
        'package.json workspaces.packages',
      );
    }
  }
  return [];
}
