import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class RootBoundaryError extends Error {
  constructor(
    message: string,
    readonly kind: 'boundary' | 'filesystem' = 'boundary',
  ) {
    super(message);
    this.name = 'RootBoundaryError';
  }
}

export function canonicalizeRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    throw new RootBoundaryError(
      `cannot resolve analysis root: ${error instanceof Error ? error.message : String(error)}`,
      'filesystem',
    );
  }
}

export function resolveContainedPath(root: string, candidate: string): string {
  const canonicalRoot = canonicalizeRoot(root);
  const logicalPath = isAbsolute(candidate) ? candidate : resolve(canonicalRoot, candidate);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(logicalPath);
  } catch (error) {
    throw new RootBoundaryError(
      `cannot resolve path inside the analysis root: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'filesystem',
    );
  }

  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RootBoundaryError('path is outside the analysis root');
  }
  return canonicalPath;
}
