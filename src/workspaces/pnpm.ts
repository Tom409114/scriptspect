/**
 * pnpm workspace globs from pnpm-workspace.yaml (`packages:` list).
 * Pure YAML parsing — pnpm itself is never executed (spec §8).
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AnalyzeError } from '../core/errors';

export function pnpmWorkspaceGlobs(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw new AnalyzeError(`${file}: cannot be read (${errorMessage(error)})`);
  }

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new AnalyzeError(`${file}: invalid YAML (${errorMessage(error)})`);
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new AnalyzeError(`${file}: workspace manifest root must be an object`);
  }
  const packages = (doc as { packages?: unknown }).packages;
  if (packages === undefined) return [];
  if (
    !Array.isArray(packages) ||
    packages.some((workspace) => typeof workspace !== 'string' || workspace.trim() === '')
  ) {
    throw new AnalyzeError(`${file}: "packages" must be an array of non-empty strings`);
  }
  return packages as string[];
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
