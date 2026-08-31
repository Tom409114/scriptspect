/**
 * Configuration loading (spec §9): a `scriptspect` field in package.json or
 * a `scriptspect.config.json` next to it. `--config` points at an explicit
 * file. Small, stable surface: targets, per-rule severity, ignore entries
 * (package globs × script globs × rule ids). No DSL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeRoot, RootBoundaryError, resolveContainedPath } from '../core/root';
import { ALL_TARGETS, DEFAULT_TARGETS } from '../core/targets';
import type { ShellTarget } from '../parser/ir';
import { getRule } from '../rules';
import type { Severity } from '../rules/types';
import { globMatch } from './match';

export interface IgnoreEntry {
  packages?: string[];
  scripts?: string[];
  rules?: string[];
}

export interface ScriptspectConfig {
  targets: readonly ShellTarget[];
  severity: ReadonlyMap<string, Severity>;
  ignore: readonly IgnoreEntry[];
}

export const CONFIG_FILENAMES = ['scriptspect.config.json'] as const;
export const PACKAGE_FIELD = 'scriptspect';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

interface RawConfig {
  targets?: unknown;
  severity?: unknown;
  ignore?: unknown;
}

/** Parse + validate a raw config object. Throws ConfigError on problems. */
export function parseConfig(raw: unknown, origin: string): ScriptspectConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${origin}: config root must be an object`);
  }
  const obj = raw as RawConfig;
  const allowedRootKeys = new Set(['targets', 'severity', 'ignore']);
  for (const key of Object.keys(obj)) {
    if (!allowedRootKeys.has(key)) {
      throw new ConfigError(`${origin}: unknown config key ${JSON.stringify(key)}`);
    }
  }

  let targets: readonly ShellTarget[] = DEFAULT_TARGETS;
  if (obj.targets !== undefined) {
    if (!Array.isArray(obj.targets) || obj.targets.length === 0) {
      throw new ConfigError(`${origin}: "targets" must be a non-empty array`);
    }
    const parsed: ShellTarget[] = [];
    for (const t of obj.targets) {
      if (typeof t !== 'string' || !ALL_TARGETS.includes(t as ShellTarget)) {
        throw new ConfigError(
          `${origin}: invalid target ${JSON.stringify(t)} (expected one of ${ALL_TARGETS.join(', ')})`,
        );
      }
      if (parsed.includes(t as ShellTarget)) {
        throw new ConfigError(`${origin}: duplicate target ${JSON.stringify(t)}`);
      }
      parsed.push(t as ShellTarget);
    }
    targets = parsed;
  }

  const severity = new Map<string, Severity>();
  if (obj.severity !== undefined) {
    if (typeof obj.severity !== 'object' || obj.severity === null || Array.isArray(obj.severity)) {
      throw new ConfigError(`${origin}: "severity" must be an object of rule id -> severity`);
    }
    for (const [ruleId, value] of Object.entries(obj.severity)) {
      if (getRule(ruleId) === undefined) {
        throw new ConfigError(`${origin}: unknown rule id "${ruleId}" in "severity"`);
      }
      if (value !== 'error' && value !== 'warn' && value !== 'advisory') {
        throw new ConfigError(`${origin}: invalid severity ${JSON.stringify(value)} for ${ruleId}`);
      }
      severity.set(ruleId, value);
    }
  }

  let ignore: readonly IgnoreEntry[] = [];
  if (obj.ignore !== undefined) {
    if (!Array.isArray(obj.ignore)) {
      throw new ConfigError(`${origin}: "ignore" must be an array`);
    }
    ignore = obj.ignore.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new ConfigError(`${origin}: ignore[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const allowedIgnoreKeys = new Set(['packages', 'scripts', 'rules']);
      for (const key of Object.keys(e)) {
        if (!allowedIgnoreKeys.has(key)) {
          throw new ConfigError(`${origin}: unknown key ${JSON.stringify(key)} in ignore[${i}]`);
        }
      }
      let specified = 0;
      for (const key of ['packages', 'scripts', 'rules'] as const) {
        const value = e[key];
        if (value === undefined) continue;
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((v) => typeof v !== 'string' || v.length === 0)
        ) {
          throw new ConfigError(
            `${origin}: ignore[${i}].${key} must be a non-empty array of strings`,
          );
        }
        if (key === 'rules') {
          if (new Set(value as string[]).size !== value.length) {
            throw new ConfigError(`${origin}: ignore[${i}].rules must not contain duplicates`);
          }
          for (const ruleId of value as string[]) {
            if (getRule(ruleId) === undefined) {
              throw new ConfigError(`${origin}: unknown rule id "${ruleId}" in ignore[${i}].rules`);
            }
          }
        }
        specified += 1;
      }
      if (specified === 0) {
        // "ignore all" is forbidden by design (spec §9): every suppression
        // must be traceable to packages, scripts, or rules.
        throw new ConfigError(
          `${origin}: ignore[${i}] must specify at least one of "packages", "scripts", or "rules" (blanket ignores are not allowed)`,
        );
      }
      if (e.rules === undefined) {
        throw new ConfigError(`${origin}: ignore[${i}].rules is required`);
      }
      return {
        packages: e.packages as string[] | undefined,
        scripts: e.scripts as string[] | undefined,
        rules: e.rules as string[] | undefined,
      };
    });
  }

  return { targets, severity, ignore };
}

/** Load config for a project root (or an explicit `--config` path). */
export function loadConfig(
  root: string,
  explicitPath?: string,
): { config: ScriptspectConfig; source: string } {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const containedFile = (candidate: string): string => {
    try {
      return resolveContainedPath(canonicalRoot, candidate);
    } catch (error) {
      if (error instanceof RootBoundaryError) throw new ConfigError(error.message);
      throw error;
    }
  };

  if (explicitPath !== undefined) {
    const file = containedFile(explicitPath);
    return { config: parseConfig(readJson(file), file), source: file };
  }

  const pkgFile = containedFile('package.json');
  try {
    const pkg = readJson(pkgFile) as Record<string, unknown>;
    const field = pkg[PACKAGE_FIELD];
    if (field !== undefined) {
      return {
        config: parseConfig(field, `${pkgFile} (field "${PACKAGE_FIELD}")`),
        source: pkgFile,
      };
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${pkgFile}: not readable — is this a Node project?`);
  }

  for (const name of CONFIG_FILENAMES) {
    const logicalFile = join(canonicalRoot, name);
    if (!existsSync(logicalFile)) continue;
    const file = containedFile(name);
    return { config: parseConfig(readJson(file), file), source: file };
  }

  return {
    config: { targets: DEFAULT_TARGETS, severity: new Map(), ignore: [] },
    source: 'defaults',
  };
}

/** True when a finding is suppressed by an ignore entry (all keys must match). */
export function isIgnored(
  config: ScriptspectConfig,
  packagePath: string,
  scriptName: string,
  ruleId: string,
): boolean {
  for (const entry of config.ignore) {
    const pkgOk =
      entry.packages === undefined || entry.packages.some((p) => globMatch(p, packagePath));
    const scriptOk =
      entry.scripts === undefined || entry.scripts.some((s) => globMatch(s, scriptName));
    const ruleOk = entry.rules === undefined || entry.rules.includes(ruleId);
    if (pkgOk && scriptOk && ruleOk) return true;
  }
  return false;
}
