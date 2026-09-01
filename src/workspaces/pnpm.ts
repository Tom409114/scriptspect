/**
 * pnpm workspace globs from pnpm-workspace.yaml (`packages:` list).
 * Pure YAML parsing — pnpm itself is never executed (spec §8).
 */
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { parse } from 'yaml';
import { AnalyzeError } from '../core/errors';
import { assertSafeWorkspaceGlobs } from './glob';

export function pnpmWorkspaceGlobs(file: string): string[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw new AnalyzeError(`${file}: cannot be read (${errorMessage(error)})`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AnalyzeError(`${file}: workspace manifest must be valid UTF-8`);
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
  if (!isPlainRecord(doc)) {
    throw new AnalyzeError(`${file}: workspace manifest root must be a plain mapping object`);
  }
  const packages = (doc as { packages?: unknown }).packages;
  if (packages === undefined) return [];
  if (
    !Array.isArray(packages) ||
    packages.some((workspace) => typeof workspace !== 'string' || workspace.trim() === '')
  ) {
    throw new AnalyzeError(`${file}: "packages" must be an array of non-empty strings`);
  }
  return assertSafeWorkspaceGlobs(packages as string[], file);
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

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
