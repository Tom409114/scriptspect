/**
 * pnpm workspace globs and link settings from repository config.
 * Pure config parsing — pnpm itself is never executed (spec §8).
 */
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { parse } from 'yaml';
import { AnalyzeError } from '../core/errors';
import { assertSafeWorkspaceGlobs } from './glob';

export function pnpmWorkspaceGlobs(file: string): string[] {
  const doc = readPnpmWorkspaceDocument(file);
  if (doc === undefined) return [];
  const packages = doc.packages;
  if (packages === undefined) return [];
  if (
    !Array.isArray(packages) ||
    packages.some((workspace) => typeof workspace !== 'string' || workspace.trim() === '')
  ) {
    throw new AnalyzeError(`${file}: "packages" must be an array of non-empty strings`);
  }
  return assertSafeWorkspaceGlobs(packages as string[], file);
}

/**
 * Whether pnpm is configured to resolve compatible ordinary semver ranges to
 * local workspace packages. The workspace manifest has precedence over the
 * legacy project `.npmrc`; absent, invalid, or environment-dependent values are
 * conservative.
 */
export function pnpmLinksWorkspacePackagesByRange(
  workspaceFile: string | undefined,
  npmrcFile: string | undefined,
): boolean {
  if (workspaceFile !== undefined) {
    const doc = readPnpmWorkspaceDocument(workspaceFile);
    const setting = doc?.linkWorkspacePackages;
    if (setting !== undefined) return setting === true || setting === 'deep';
  }
  return npmrcFile === undefined ? false : legacyNpmrcLinksWorkspacePackages(npmrcFile);
}

function readPnpmWorkspaceDocument(file: string): Record<string, unknown> | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
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
  return doc;
}

function legacyNpmrcLinksWorkspacePackages(file: string): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw new AnalyzeError(`${file}: cannot be read (${errorMessage(error)})`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AnalyzeError(`${file}: npm config must be valid UTF-8`);
  }

  let value: string | undefined;
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    if (line.slice(0, equals).trim().toLowerCase() !== 'link-workspace-packages') continue;
    value = line
      .slice(equals + 1)
      .trim()
      .toLowerCase();
  }
  return value === 'true' || value === 'deep';
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
