/**
 * Workspace package discovery (spec §8): root package + every workspace
 * package from npm/Yarn/Bun `workspaces` globs and pnpm-workspace.yaml.
 *
 * Safety invariants (spec §13.1):
 * - node_modules, vendor/build dirs, dotfolders never enter the scan
 * - symlinked paths are canonicalized; loops terminate; results are deduped
 * - every discovered directory must stay inside the analysis root
 */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import type { PackageManifest, PackageUnit } from '../core/analyze';
import { readManifest, toPosix } from '../core/analyze';
import { AnalyzeError } from '../core/errors';
import { canonicalizeRoot, RootBoundaryError, resolveContainedPath } from '../core/root';
import { npmWorkspaceGlobs } from './npm';
import { pnpmWorkspaceGlobs } from './pnpm';

/** Directories that never contain analyzable workspace packages. */
export const EXCLUDED_DIRS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.yarn/**',
  '**/coverage/**',
];

export interface DiscoveryResult {
  packages: PackageUnit[];
  /** Non-fatal notes (skipped dirs without package.json, symlink escapes). */
  notes: string[];
}

/** Discover the root package plus all workspace packages (deterministic order). */
export function discoverPackages(root: string): DiscoveryResult {
  const notes: string[] = [];
  const rootReal = canonicalRoot(root);
  const rootManifest = containedPath(rootReal, join(rootReal, 'package.json'), 'root manifest');
  const rootUnit = packageUnit(rootReal, rootReal, 'package.json', rootManifest);

  const globs = new Set<string>();
  for (const g of npmWorkspaceGlobs(rootUnit.manifest.workspaces)) globs.add(g);
  const logicalPnpmWorkspace = join(rootReal, 'pnpm-workspace.yaml');
  if (existsSync(logicalPnpmWorkspace)) {
    const pnpmWorkspace = containedPath(rootReal, logicalPnpmWorkspace, 'pnpm workspace manifest');
    for (const g of pnpmWorkspaceGlobs(pnpmWorkspace)) globs.add(g);
  }

  const units: PackageUnit[] = [rootUnit];
  const seen = new Set<string>([rootManifest]);

  if (globs.size > 0) {
    const dirs = fg.sync([...globs], {
      cwd: rootReal,
      onlyDirectories: true,
      ignore: EXCLUDED_DIRS,
      followSymbolicLinks: false,
      dot: false,
      unique: true,
    });
    for (const dir of dirs.sort()) {
      const abs = resolve(rootReal, dir);
      if (!existsSync(join(abs, 'package.json'))) continue; // glob matched a non-package dir
      let real: string;
      try {
        real = resolveContainedPath(rootReal, abs);
      } catch (error) {
        if (!(error instanceof RootBoundaryError)) throw error;
        notes.push(`skipped ${toPosix(relative(rootReal, abs))}: path escapes the project root`);
        continue;
      }
      const manifestFile = join(real, 'package.json');
      const realFile = containedPath(rootReal, manifestFile, 'workspace manifest');
      if (seen.has(realFile)) continue; // dedupe (incl. symlink loops)
      seen.add(realFile);
      const relPath = toPosix(join(relative(rootReal, real), 'package.json'));
      units.push(packageUnit(real, rootReal, relPath, realFile));
    }
  }

  return { packages: units, notes };
}

function packageUnit(
  absDir: string,
  root: string,
  relPath: string,
  manifestFile: string,
): PackageUnit {
  const manifest = readManifest(manifestFile);
  return { relPath, absDir: absDir === root ? root : absDir, manifest };
}

function canonicalRoot(root: string): string {
  try {
    return canonicalizeRoot(root);
  } catch (error) {
    throw new AnalyzeError(error instanceof Error ? error.message : String(error));
  }
}

function containedPath(root: string, candidate: string, label: string): string {
  try {
    return resolveContainedPath(root, candidate);
  } catch (error) {
    if (error instanceof RootBoundaryError) {
      throw new AnalyzeError(`${label} is outside the project root`);
    }
    throw error;
  }
}

/** Bin names a manifest actually exposes through its `bin` declaration. */
export function manifestBinNames(manifest: PackageManifest): Set<string> {
  const names = new Set<string>();
  const bin = manifest.bin;
  if (bin === undefined) return names;
  if (typeof bin === 'string') {
    const name = manifest.name?.split('/').at(-1);
    if (name !== undefined && name !== '') names.add(name);
    return names;
  }
  for (const binName of Object.keys(bin)) names.add(binName);
  return names;
}

/** Union of real bin declarations; useful for inventory, never visibility. */
export function workspaceBinNames(packages: readonly PackageUnit[]): Set<string> {
  const names = new Set<string>();
  for (const unit of packages) {
    for (const name of manifestBinNames(unit.manifest)) names.add(name);
  }
  return names;
}

/**
 * Conservative package-manager-neutral workspace bin visibility. Only a
 * declared dependency/devDependency on a named workspace package exposes
 * that package's real bin declaration to the calling unit.
 */
export function visibleWorkspaceBins(
  caller: PackageUnit,
  packages: readonly PackageUnit[],
): Set<string> {
  const declared = new Set([
    ...Object.keys(caller.manifest.dependencies ?? {}),
    ...Object.keys(caller.manifest.devDependencies ?? {}),
  ]);
  const names = new Set<string>();
  for (const unit of packages) {
    const packageName = unit.manifest.name;
    if (packageName === undefined || !declared.has(packageName)) continue;
    for (const name of manifestBinNames(unit.manifest)) names.add(name);
  }
  return names;
}

/** Dependency names of one package unit. */
export function unitDependencyNames(unit: PackageUnit): Set<string> {
  const names = new Set<string>();
  for (const block of [
    unit.manifest.dependencies,
    unit.manifest.devDependencies,
    unit.manifest.optionalDependencies,
    unit.manifest.peerDependencies,
  ]) {
    if (block === undefined) continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return names;
}

export type { PackageManifest };
