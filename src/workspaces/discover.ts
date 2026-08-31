/**
 * Workspace package discovery (spec §8): root package + every workspace
 * package from npm/Yarn/Bun `workspaces` globs and pnpm-workspace.yaml.
 *
 * Safety invariants (spec §13.1):
 * - node_modules, vendor/build dirs, dotfolders never enter the scan
 * - symlinked paths are canonicalized; loops terminate; results are deduped
 * - every discovered directory must stay inside the analysis root
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { npmWorkspaceGlobs } from './npm';
import { pnpmWorkspaceGlobs } from './pnpm';
import type { PackageManifest, PackageUnit } from '../core/analyze';
import { readManifest, toPosix } from '../core/analyze';

/** Directories that never contain analyzable workspace packages. */
export const EXCLUDED_DIRS = ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/.yarn/**', '**/coverage/**'];

export interface DiscoveryResult {
  packages: PackageUnit[];
  /** Non-fatal notes (skipped dirs without package.json, symlink escapes). */
  notes: string[];
}

/** True when `dir` is inside `root` after canonicalization. */
function isInside(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return true;
}

/** Discover the root package plus all workspace packages (deterministic order). */
export function discoverPackages(root: string): DiscoveryResult {
  const notes: string[] = [];
  const rootReal = realpathOrSelf(root);
  const rootUnit = packageUnit(rootReal, rootReal, 'package.json');

  const globs = new Set<string>();
  globs.add(...npmWorkspaceGlobs(rootUnit.manifest.workspaces));
  globs.add(...pnpmWorkspaceGlobs(join(rootReal, 'pnpm-workspace.yaml')));

  const units: PackageUnit[] = [rootUnit];
  const seen = new Set<string>([realpathOrSelf(join(rootReal, 'package.json'))]);

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
      const real = realpathOrSelf(abs);
      if (!isInside(rootReal, real)) {
        notes.push(`skipped ${toPosix(relative(rootReal, abs))}: symlink escapes the project root`);
        continue;
      }
      const manifestFile = join(real, 'package.json');
      const realFile = realpathOrSelf(manifestFile);
      if (seen.has(realFile)) continue; // dedupe (incl. symlink loops)
      seen.add(realFile);
      const relPath = toPosix(join(relative(rootReal, real), 'package.json'));
      units.push(packageUnit(real, rootReal, relPath));
    }
  }

  return { packages: units, notes };
}

function packageUnit(absDir: string, root: string, relPath: string): PackageUnit {
  const manifest = readManifest(join(absDir, 'package.json'));
  return { relPath, absDir: absDir === root ? root : absDir, manifest };
}

/** realpath that falls back to the input when the FS refuses (e.g. missing). */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Union of bin names across the root and all workspace packages (for PS040). */
export function workspaceBinNames(packages: readonly PackageUnit[]): Set<string> {
  const names = new Set<string>();
  for (const unit of packages) {
    if (unit.manifest.name !== undefined) names.add(unit.manifest.name);
    const bin = unit.manifest.bin;
    if (bin === undefined) continue;
    if (typeof bin === 'string') continue; // name already added
    for (const binName of Object.keys(bin)) names.add(binName);
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
