/**
 * Workspace package discovery (spec §8): root package + every workspace
 * package from npm/Yarn/Bun `workspaces` globs and pnpm-workspace.yaml.
 *
 * Safety invariants (spec §13.1):
 * - node_modules, vendor/build dirs, dotfolders never enter the scan
 * - symlinked paths are canonicalized; loops terminate; results are deduped
 * - every discovered directory must stay inside the analysis root
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { satisfies, valid, validRange } from 'semver';
import type { PackageManifest, PackageUnit } from '../core/analyze';
import { readManifest, toPosix } from '../core/analyze';
import { AnalyzeError } from '../core/errors';
import { canonicalizeRoot, RootBoundaryError, resolveContainedPath } from '../core/root';
import { assertWorkspaceGlobBasesContained, workspaceGlobEngine } from './glob';
import { npmWorkspaceGlobs } from './npm';
import { pnpmLinksWorkspacePackagesByRange, pnpmWorkspaceGlobs } from './pnpm';

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
  /** Deterministic package-manager identity; conflicts and unknowns fail conservative. */
  packageManager: WorkspacePackageManager;
  /** Whether root dependency bins are provably on every workspace script PATH. */
  rootToolchainBinsReachLeaves: boolean;
  /** Whether ordinary compatible semver ranges resolve to local workspaces. */
  ordinaryWorkspaceRangesResolveLocally: boolean;
  /** Non-fatal notes (skipped dirs without package.json, symlink escapes). */
  notes: string[];
}

export type WorkspacePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

const MANAGER_LOCKFILES: Readonly<Record<Exclude<WorkspacePackageManager, 'unknown'>, string[]>> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};

/** Discover the root package plus all workspace packages (deterministic order). */
export function discoverPackages(root: string): DiscoveryResult {
  const notes: string[] = [];
  const rootReal = canonicalRoot(root);
  const rootManifest = containedPath(rootReal, join(rootReal, 'package.json'), 'root manifest');
  const rootUnit = packageUnit(rootReal, rootReal, 'package.json', rootManifest);

  const globs = new Set<string>();
  for (const g of npmWorkspaceGlobs(rootUnit.manifest.workspaces)) globs.add(g);
  const logicalPnpmWorkspace = join(rootReal, 'pnpm-workspace.yaml');
  let pnpmWorkspaceFile: string | undefined;
  if (manifestExists(logicalPnpmWorkspace)) {
    const pnpmWorkspace = containedPath(rootReal, logicalPnpmWorkspace, 'pnpm workspace manifest');
    pnpmWorkspaceFile = pnpmWorkspace;
    for (const g of pnpmWorkspaceGlobs(pnpmWorkspace)) globs.add(g);
  }

  const units: PackageUnit[] = [rootUnit];
  const seen = new Set<string>([rootManifest]);

  if (globs.size > 0) {
    const patterns = [...globs];
    assertWorkspaceGlobBasesContained(rootReal, patterns);
    const dirs = workspaceGlobEngine.sync(patterns, {
      cwd: rootReal,
      onlyDirectories: true,
      ignore: EXCLUDED_DIRS,
      followSymbolicLinks: false,
      dot: false,
      unique: true,
    });
    for (const dir of dirs.sort()) {
      const abs = resolve(rootReal, dir);
      let real: string;
      try {
        real = resolveContainedPath(rootReal, abs);
      } catch (error) {
        if (!(error instanceof RootBoundaryError)) throw error;
        if (error.kind === 'filesystem') {
          throw new AnalyzeError(`${abs}: ${error.message}`);
        }
        notes.push(`skipped ${toPosix(relative(rootReal, abs))}: path escapes the project root`);
        continue;
      }
      const manifestFile = join(real, 'package.json');
      if (!manifestExists(manifestFile)) continue; // glob matched a non-package dir
      const realFile = containedPath(rootReal, manifestFile, 'workspace manifest');
      if (seen.has(realFile)) continue; // dedupe (incl. symlink loops)
      seen.add(realFile);
      const relPath = toPosix(join(relative(rootReal, real), 'package.json'));
      units.push(packageUnit(real, rootReal, relPath, realFile));
    }
  }

  const packageManager = detectWorkspacePackageManager(rootReal, rootUnit.manifest);
  const logicalNpmrc = join(rootReal, '.npmrc');
  const npmrcFile =
    packageManager === 'pnpm' && pathEntryExists(logicalNpmrc)
      ? containedPath(rootReal, logicalNpmrc, 'project npm config')
      : undefined;
  return {
    packages: units,
    packageManager,
    rootToolchainBinsReachLeaves:
      packageManager === 'npm' ||
      packageManager === 'pnpm' ||
      (packageManager === 'yarn' && yarnClassicUsesRootBins(rootReal, rootUnit.manifest)),
    ordinaryWorkspaceRangesResolveLocally:
      packageManager === 'pnpm'
        ? pnpmLinksWorkspacePackagesByRange(pnpmWorkspaceFile, npmrcFile)
        : packageManager !== 'unknown',
    notes,
  };
}

type YarnLockKind = 'classic' | 'modern' | 'unknown' | 'absent';

/** Yarn Classic node_modules workspaces add the workspace-root .bin to script PATH. */
function yarnClassicUsesRootBins(root: string, manifest: PackageManifest): boolean {
  if (yarnPnpEnabled(root, manifest)) return false;
  const declared = manifest.packageManager;
  const lockKind = yarnLockKind(root);
  if (typeof declared === 'string' && declared.startsWith('yarn@')) {
    const major = /^yarn@(\d+)(?:\.|$)/u.exec(declared)?.[1];
    if (major !== '1') return false;
    return lockKind !== 'modern';
  }
  return lockKind === 'classic';
}

function yarnPnpEnabled(root: string, manifest: PackageManifest): boolean {
  const installConfig = manifest.installConfig;
  if (
    typeof installConfig === 'object' &&
    installConfig !== null &&
    !Array.isArray(installConfig) &&
    (installConfig as { pnp?: unknown }).pnp === true
  ) {
    return true;
  }
  return (
    pathEntryExists(join(root, '.pnp.js')) ||
    pathEntryExists(join(root, '.pnp.cjs')) ||
    yarnClassicRcEnablesPnp(root)
  );
}

function yarnClassicRcEnablesPnp(root: string): boolean {
  const logicalFile = join(root, '.yarnrc');
  if (!pathEntryExists(logicalFile)) return false;
  const file = containedPath(root, logicalFile, 'Yarn Classic config');
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new AnalyzeError(
      `${file}: cannot read Yarn Classic config (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AnalyzeError(`${file}: Yarn Classic config must be valid UTF-8`);
  }
  return /^\s*--enable-pnp(?:\s+|=)(?:true|1)\s*(?:#.*)?$/mu.test(source);
}

function yarnLockKind(root: string): YarnLockKind {
  const logicalFile = join(root, 'yarn.lock');
  if (!pathEntryExists(logicalFile)) return 'absent';
  const file = containedPath(root, logicalFile, 'Yarn lockfile');
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    throw new AnalyzeError(`${file}: cannot inspect Yarn lockfile format`);
  }
  if (/^# yarn lockfile v1\s*$/mu.test(source)) return 'classic';
  if (/^__metadata:\s*$/mu.test(source)) return 'modern';
  return 'unknown';
}

/**
 * Resolve the package manager from an explicit packageManager field and root
 * lockfiles. Any malformed declaration or cross-manager conflict returns
 * unknown so callers do not assume hoisted/root-bin visibility.
 */
export function detectWorkspacePackageManager(
  root: string,
  manifest: PackageManifest,
): WorkspacePackageManager {
  const declaredValue: unknown = manifest.packageManager;
  let declared: Exclude<WorkspacePackageManager, 'unknown'> | undefined;
  if (declaredValue !== undefined) {
    if (typeof declaredValue !== 'string') return 'unknown';
    const match = /^(npm|pnpm|yarn|bun)@\S+$/.exec(declaredValue);
    if (match === null) return 'unknown';
    declared = match[1] as Exclude<WorkspacePackageManager, 'unknown'>;
  }

  const signals = new Set<Exclude<WorkspacePackageManager, 'unknown'>>();
  if (declared !== undefined) signals.add(declared);
  for (const [manager, lockfiles] of Object.entries(MANAGER_LOCKFILES) as Array<
    [Exclude<WorkspacePackageManager, 'unknown'>, string[]]
  >) {
    if (lockfiles.some((file) => regularFileExists(join(root, file)))) signals.add(manager);
  }

  return signals.size === 1 ? ([...signals][0] ?? 'unknown') : 'unknown';
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
      if (error.kind === 'filesystem') {
        throw new AnalyzeError(`${candidate}: ${error.message}`);
      }
      throw new AnalyzeError(`${label} is outside the project root`);
    }
    throw error;
  }
}

function manifestExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw new AnalyzeError(
      `${file}: cannot inspect manifest (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
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

/**
 * Package identities whose well-known registry bins are locally provable.
 * npm aliases contribute their real target; workspace dependencies are
 * deliberately excluded because only their actual manifest `bin` is proof.
 */
export function dependencyProviderNames(
  caller: PackageUnit,
  packages: readonly PackageUnit[],
  ordinaryWorkspaceRangesResolveLocally = true,
): Set<string> {
  const workspaceUnits = uniqueWorkspaceUnitsByName(packages);
  const providers = new Set<string>();
  for (const [declaredName, spec] of executableDependencyEntries(caller.manifest)) {
    const aliasTarget = npmAliasTarget(spec);
    if (aliasTarget !== undefined) {
      providers.add(aliasTarget);
      continue;
    }
    if (
      workspaceDependencyTarget(
        declaredName,
        spec,
        workspaceUnits,
        ordinaryWorkspaceRangesResolveLocally,
      ) !== undefined
    ) {
      continue;
    }
    if (registrySpecKeepsPackageIdentity(spec)) providers.add(declaredName);
  }
  return providers;
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
 * Manager-aware workspace bin visibility. Explicit `workspace:` dependencies
 * resolve locally; ordinary compatible ranges do so only when the detected
 * package-manager configuration proves that behavior.
 */
export function visibleWorkspaceBins(
  caller: PackageUnit,
  packages: readonly PackageUnit[],
  ordinaryWorkspaceRangesResolveLocally = true,
): Set<string> {
  const workspaceUnits = uniqueWorkspaceUnitsByName(packages);
  const declaredWorkspaceTargets = new Set<string>();
  for (const [declaredName, spec] of executableDependencyEntries(caller.manifest)) {
    const target = workspaceDependencyTarget(
      declaredName,
      spec,
      workspaceUnits,
      ordinaryWorkspaceRangesResolveLocally,
    );
    if (target !== undefined) declaredWorkspaceTargets.add(target);
  }
  const names = new Set<string>();
  for (const unit of packages) {
    const packageName = unit.manifest.name;
    if (packageName === undefined || !declaredWorkspaceTargets.has(packageName)) continue;
    for (const name of manifestBinNames(unit.manifest)) names.add(name);
  }
  return names;
}

function executableDependencyEntries(manifest: PackageManifest): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const block of [manifest.dependencies, manifest.devDependencies]) {
    if (block === undefined) continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === 'string') entries.push([name, spec.trim()]);
    }
  }
  return entries;
}

function workspaceDependencyTarget(
  declaredName: string,
  spec: string,
  workspaceUnits: ReadonlyMap<string, PackageUnit | null>,
  ordinaryWorkspaceRangesResolveLocally: boolean,
): string | undefined {
  if (npmAliasTarget(spec) !== undefined) return undefined;
  if (spec.startsWith('workspace:')) {
    const workspaceSpec = spec.slice('workspace:'.length);
    const target =
      workspaceSpec === '' || /^(?:[*^~<>=]|v?\d)/.test(workspaceSpec)
        ? declaredName
        : packageNameBeforeRange(workspaceSpec);
    return target !== undefined && workspaceUnits.get(target) !== null && workspaceUnits.has(target)
      ? target
      : undefined;
  }

  if (!ordinaryWorkspaceRangesResolveLocally || !registrySpecKeepsPackageIdentity(spec)) {
    return undefined;
  }
  const unit = workspaceUnits.get(declaredName);
  if (unit === undefined || unit === null) return undefined;
  const version = unit.manifest.version;
  const range = spec === '' ? '*' : spec;
  if (typeof version !== 'string' || valid(version) === null || validRange(range) === null) {
    return undefined;
  }
  return satisfies(version, range) ? declaredName : undefined;
}

/** Duplicate workspace names are ambiguous and therefore never treated as installed bins. */
function uniqueWorkspaceUnitsByName(
  packages: readonly PackageUnit[],
): Map<string, PackageUnit | null> {
  const units = new Map<string, PackageUnit | null>();
  for (const unit of packages) {
    const name = unit.manifest.name;
    if (name === undefined) continue;
    units.set(name, units.has(name) ? null : unit);
  }
  return units;
}

function npmAliasTarget(spec: string): string | undefined {
  if (!spec.startsWith('npm:')) return undefined;
  return packageNameBeforeRange(spec.slice('npm:'.length));
}

function packageNameBeforeRange(spec: string): string | undefined {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash <= 1) return undefined;
    const rangeAt = spec.indexOf('@', slash + 1);
    const name = rangeAt === -1 ? spec : spec.slice(0, rangeAt);
    return /^@[^@/\s]+\/[^@/\s]+$/.test(name) ? name : undefined;
  }
  const rangeAt = spec.indexOf('@');
  const name = rangeAt === -1 ? spec : spec.slice(0, rangeAt);
  return /^[^@/\s]+$/.test(name) && name !== '' ? name : undefined;
}

function registrySpecKeepsPackageIdentity(spec: string): boolean {
  if (spec === '') return true;
  if (spec.startsWith('catalog:')) return true;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(spec)) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\')) return false;
  if (spec.includes('/') || /\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(spec)) return false;
  return true;
}

function regularFileExists(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw new AnalyzeError(`${file}: cannot inspect package-manager signal`);
  }
}

function pathEntryExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw new AnalyzeError(`${file}: cannot inspect package-manager signal`);
  }
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
