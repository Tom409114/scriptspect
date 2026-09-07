import { createHash } from 'node:crypto';

export interface CorpusLimits {
  maxTreeEntries: number;
  maxManifests: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_CORPUS_LIMITS: Readonly<CorpusLimits> = {
  maxTreeEntries: 20_000,
  maxManifests: 500,
  maxDepth: 12,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 10_485_760,
};

export interface RepoLocator {
  repo: string;
  commit: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit' | string;
  mode: string;
  size?: number;
  sha: string;
  url?: string;
}

export interface SelectedCorpusFiles {
  files: TreeEntry[];
  /** Root npm lockfiles whose presence is projected without downloading their bytes. */
  managerSignals: TreeEntry[];
  truncations: string[];
}

export interface SampleFinding {
  findingId: string;
  ruleId: string;
  severity: 'error' | 'warn' | 'advisory';
  confidence: 'high' | 'medium';
}

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'vendors',
  'dist',
  'build',
  'coverage',
  'generated',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
]);

const ROOT_NPM_MANAGER_SIGNALS = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Derive the canonical Git object ID for exact blob bytes. */
export function gitBlobOid(value: string | Buffer): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function parseRepoLocator(value: string): RepoLocator {
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))@([a-f0-9]{40})$/.exec(
      value.trim(),
    );
  if (match === null || match[1]?.includes('..') || match[1]?.endsWith('.')) {
    throw new Error('expected immutable repository locator owner/repo@40-character-commit');
  }
  return { repo: match[1] as string, commit: match[2] as string };
}

function safeRepositoryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  const segments = path.split('/');
  return segments.every(
    (segment) =>
      segment !== '' && segment !== '.' && segment !== '..' && !EXCLUDED_SEGMENTS.has(segment),
  );
}

function isCandidate(entry: TreeEntry): boolean {
  if (entry.type !== 'blob' || entry.mode === '120000' || !safeRepositoryPath(entry.path)) {
    return false;
  }
  return entry.path === 'pnpm-workspace.yaml' || entry.path.endsWith('package.json');
}

function isRootNpmManagerSignal(entry: TreeEntry): boolean {
  return (
    entry.type === 'blob' && entry.mode !== '120000' && ROOT_NPM_MANAGER_SIGNALS.has(entry.path)
  );
}

function addTruncation(truncations: string[], reason: string): void {
  if (!truncations.includes(reason)) truncations.push(reason);
}

function boundedTreeEntries(tree: readonly TreeEntry[], maxTreeEntries: number): TreeEntry[] {
  const rootControlFiles = tree
    .filter(
      (entry) =>
        ((entry.path === 'package.json' || entry.path === 'pnpm-workspace.yaml') &&
          isCandidate(entry)) ||
        isRootNpmManagerSignal(entry),
    )
    .sort((left, right) => {
      if (left.path === 'package.json') return -1;
      if (right.path === 'package.json') return 1;
      return left.path.localeCompare(right.path);
    });
  const rootPaths = new Set(rootControlFiles.map((entry) => entry.path));
  const boundedPrefix = tree.slice(0, maxTreeEntries).filter((entry) => !rootPaths.has(entry.path));
  return [...rootControlFiles, ...boundedPrefix].slice(0, maxTreeEntries);
}

/** Select only bounded manifest inputs; every discarded limit is surfaced. */
export function selectCorpusFiles(
  tree: readonly TreeEntry[],
  limits: CorpusLimits,
): SelectedCorpusFiles {
  const truncations: string[] = [];
  if (tree.length > limits.maxTreeEntries) {
    addTruncation(truncations, `tree-entry-limit:${limits.maxTreeEntries}`);
  }
  const bounded = boundedTreeEntries(tree, limits.maxTreeEntries);
  const candidates = bounded.filter(isCandidate).sort((left, right) => {
    if (left.path === 'package.json') return -1;
    if (right.path === 'package.json') return 1;
    if (left.path === 'pnpm-workspace.yaml') return -1;
    if (right.path === 'pnpm-workspace.yaml') return 1;
    return left.path.localeCompare(right.path);
  });
  const managerSignals = bounded
    .filter(isRootNpmManagerSignal)
    .sort((left, right) => left.path.localeCompare(right.path));

  const files: TreeEntry[] = [];
  let totalBytes = 0;
  let manifestCount = 0;
  for (const entry of candidates) {
    const depth = entry.path.split('/').length;
    const size = entry.size ?? limits.maxFileBytes + 1;
    if (depth > limits.maxDepth) {
      addTruncation(truncations, `depth-limit:${limits.maxDepth}`);
      continue;
    }
    if (size > limits.maxFileBytes) {
      addTruncation(truncations, `file-byte-limit:${limits.maxFileBytes}`);
      continue;
    }
    const isManifest = entry.path.endsWith('package.json');
    const overManifestLimit = isManifest && manifestCount >= limits.maxManifests;
    const overByteLimit = totalBytes + size > limits.maxTotalBytes;
    if (overManifestLimit) addTruncation(truncations, `manifest-limit:${limits.maxManifests}`);
    if (overByteLimit) addTruncation(truncations, `byte-limit:${limits.maxTotalBytes}`);
    if (overManifestLimit || overByteLimit) continue;

    files.push(entry);
    totalBytes += size;
    if (isManifest) manifestCount += 1;
  }
  return { files, managerSignals, truncations };
}

/** Remove common token/credential shapes before any public evidence is persisted. */
export function redactCorpusText(value: string): string {
  return value
    .replace(/\b(?:github_pat|gh[oprsu])_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(
      /\b(?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/giu,
      '[REDACTED]',
    );
}

/** Deterministically round-robin rule/severity/confidence strata. */
export function stratifiedSample<T extends SampleFinding>(
  findings: readonly T[],
  size: number,
  seed: string,
): T[] {
  if (!Number.isSafeInteger(size) || size < 1 || size > findings.length) {
    throw new Error('sample size must be a positive integer no larger than the finding set');
  }
  const identifiers = new Set<string>();
  const strata = new Map<string, T[]>();
  for (const finding of findings) {
    if (identifiers.has(finding.findingId)) {
      throw new Error(`duplicate findingId: ${finding.findingId}`);
    }
    identifiers.add(finding.findingId);
    const key = `${finding.ruleId}\0${finding.severity}\0${finding.confidence}`;
    const stratum = strata.get(key);
    if (stratum === undefined) strata.set(key, [finding]);
    else stratum.push(finding);
  }
  const queues = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entries]) =>
      entries.toSorted((left, right) => {
        const byDigest = sha256(`${seed}\0${left.findingId}`).localeCompare(
          sha256(`${seed}\0${right.findingId}`),
        );
        return byDigest === 0 ? left.findingId.localeCompare(right.findingId) : byDigest;
      }),
    );
  const selected: T[] = [];
  for (let offset = 0; selected.length < size; offset += 1) {
    for (const queue of queues) {
      const candidate = queue[offset];
      if (candidate !== undefined) selected.push(candidate);
      if (selected.length === size) return selected;
    }
  }
  return selected;
}
