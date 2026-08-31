/**
 * pnpm workspace globs from pnpm-workspace.yaml (`packages:` list).
 * Pure YAML parsing — pnpm itself is never executed (spec §8).
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export function pnpmWorkspaceGlobs(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  const packages = (doc as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];
  return packages.filter((w): w is string => typeof w === 'string' && w.trim() !== '');
}
