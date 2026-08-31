/**
 * CLI option normalization and validation. Invalid values are tool errors
 * (exit code 2), not findings.
 */
import type { ShellTarget } from '../parser/ir';
import { ALL_TARGETS } from '../core/targets';
import { getRule } from '../rules';

export type Format = 'stylish' | 'json' | 'github';
export type Severity = 'error' | 'warn' | 'advisory';

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, advisory: 2 };

export interface CliOptions {
  format: Format;
  severity: Severity;
  targets?: ShellTarget[];
  rules?: ReadonlySet<string>;
  quiet: boolean;
  color: boolean;
  maxWarnings: number;
  configPath?: string;
  fix: boolean;
  fixDryRun: boolean;
}

export class CliOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliOptionError';
  }
}

export function normalizeOptions(raw: Record<string, unknown>): CliOptions {
  const format = typeof raw.format === 'string' ? raw.format : 'stylish';
  if (format !== 'stylish' && format !== 'json' && format !== 'github') {
    throw new CliOptionError(`invalid --format "${format}" (expected stylish, json, or github)`);
  }

  const severity = typeof raw.severity === 'string' ? raw.severity : 'advisory';
  if (severity !== 'error' && severity !== 'warn' && severity !== 'advisory') {
    throw new CliOptionError(`invalid --severity "${severity}" (expected error, warn, or advisory)`);
  }

  let targets: ShellTarget[] | undefined;
  if (typeof raw.target === 'string' && raw.target !== '') {
    targets = [];
    for (const part of raw.target.split(',')) {
      const t = part.trim();
      if (t === '') continue;
      if (!ALL_TARGETS.includes(t as ShellTarget)) {
        throw new CliOptionError(`invalid --target "${t}" (expected one of ${ALL_TARGETS.join(', ')})`);
      }
      if (!targets.includes(t as ShellTarget)) targets.push(t as ShellTarget);
    }
    if (targets.length === 0) targets = undefined;
  }

  let rules: ReadonlySet<string> | undefined;
  if (typeof raw.rule === 'string' && raw.rule !== '') {
    const ids: string[] = [];
    for (const part of raw.rule.split(',')) {
      const id = part.trim();
      if (id === '') continue;
      if (getRule(id) === undefined) {
        throw new CliOptionError(`unknown rule id "${id}" in --rule`);
      }
      ids.push(id);
    }
    if (ids.length > 0) rules = new Set(ids);
  }

  let maxWarnings = Number.POSITIVE_INFINITY;
  if (raw.maxWarnings !== undefined) {
    const n = Number(raw.maxWarnings);
    if (!Number.isInteger(n) || n < 0) {
      throw new CliOptionError(`invalid --max-warnings "${String(raw.maxWarnings)}" (expected a non-negative integer)`);
    }
    maxWarnings = n;
  }

  return {
    format,
    severity,
    targets,
    rules,
    quiet: raw.quiet === true,
    color: raw.noColor !== true,
    maxWarnings,
    configPath: typeof raw.config === 'string' ? raw.config : undefined,
    fix: raw.fix === true,
    fixDryRun: raw.fixDryRun === true,
  };
}
