import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import { AnalyzeError } from '../core/errors';

/** Shared engine so CLI builds emit one production dependency import. */
export const workspaceGlobEngine = fg;

/**
 * Glob syntax can hide an absolute path or `..` behind negation, braces, or
 * extglob branches. Ask fast-glob only to build its pure in-memory task plan,
 * then validate every expanded branch before filesystem discovery starts.
 * Slash normalization keeps Windows paths fail-closed on every host OS.
 */
const ABSOLUTE_BRANCH = /(^|[(,|])(?:\/|[A-Za-z]:)/u;
const PARENT_SEGMENT = /(^|[/,(|])\.\.(?=$|[/,)|])/u;

function positivePattern(pattern: string): string {
  let positive = pattern;
  while (positive.startsWith('!') && positive[1] !== '(') positive = positive.slice(1);
  return positive;
}

function isUnsafeBranch(branch: string): boolean {
  const normalized = branch.replace(/\\/g, '/');
  return ABSOLUTE_BRANCH.test(normalized) || PARENT_SEGMENT.test(normalized);
}

function isUnsafePattern(pattern: string): boolean {
  const normalized = positivePattern(pattern.replace(/\\/g, '/'));
  if (normalized === '') return true;

  try {
    const tasks = fg.generateTasks([normalized]);
    if (tasks.length === 0) return true;
    return [
      normalized,
      ...tasks.flatMap((task) => [task.base, ...task.patterns, ...task.positive, ...task.negative]),
    ].some(isUnsafeBranch);
  } catch {
    return true;
  }
}

export function assertSafeWorkspaceGlob(pattern: string, origin: string): string {
  if (isUnsafePattern(pattern)) {
    throw new AnalyzeError(
      `${origin}: unsafe workspace glob ${JSON.stringify(pattern)} must stay inside the project root`,
    );
  }
  return pattern;
}

export function assertSafeWorkspaceGlobs(patterns: readonly string[], origin: string): string[] {
  return patterns.map((pattern) => assertSafeWorkspaceGlob(pattern, origin));
}

/**
 * Validate every existing segment of each static glob base before fast-glob
 * receives the patterns. `followSymbolicLinks: false` does not protect a
 * symlink that is itself part of fast-glob's starting base.
 */
export function assertWorkspaceGlobBasesContained(root: string, patterns: readonly string[]): void {
  for (const pattern of patterns) {
    let tasks: ReturnType<typeof fg.generateTasks>;
    try {
      tasks = fg.generateTasks([positivePattern(pattern)]);
    } catch (error) {
      throw new AnalyzeError(
        `unsafe workspace glob ${JSON.stringify(pattern)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const bases = new Set(tasks.flatMap((task) => (task.dynamic ? [task.base] : task.positive)));
    for (const base of bases) assertStaticBaseContained(root, base, pattern);
  }
}

function assertStaticBaseContained(root: string, base: string, pattern: string): void {
  const segments = base.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = root;

  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') throw escapingBaseError(pattern);

    const candidate = join(current, segment);
    try {
      lstatSync(candidate);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return;
      throw baseFilesystemError(pattern, candidate, error);
    }

    let canonical: string;
    try {
      canonical = realpathSync(candidate);
    } catch (error) {
      throw baseFilesystemError(pattern, candidate, error);
    }

    const rel = relative(root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw escapingBaseError(pattern);
    }
    current = canonical;
  }
}

function escapingBaseError(pattern: string): AnalyzeError {
  return new AnalyzeError(
    `workspace glob ${JSON.stringify(pattern)} has a static base outside the project root`,
  );
}

function baseFilesystemError(pattern: string, candidate: string, error: unknown): AnalyzeError {
  return new AnalyzeError(
    `workspace glob ${JSON.stringify(pattern)} cannot inspect static base ${candidate}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
