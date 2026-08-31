import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ALL_TARGETS } from './core/targets';
import type { ShellTarget } from './parser/ir';
import type { Severity } from './rules/types';

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionInputError';
  }
}

export interface ActionInputs {
  workspace: string;
  path: string;
  targets?: ShellTarget[];
  severity?: Severity;
  maxWarnings: number;
}

/** Whether a resolved physical path is contained by a workspace root. */
export function isWithinWorkspace(workspace: string, candidate: string): boolean {
  const rel = relative(workspace, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function input(env: NodeJS.ProcessEnv, name: string): string {
  return env[`INPUT_${name}`] ?? '';
}

function parseTargets(value: string): ShellTarget[] | undefined {
  if (value === '') return undefined;
  const targets = value.split(',');
  if (
    targets.length === 0 ||
    targets.some((target) => !ALL_TARGETS.includes(target as ShellTarget)) ||
    new Set(targets).size !== targets.length
  ) {
    throw new ActionInputError('invalid target input');
  }
  return targets as ShellTarget[];
}

function parseSeverity(value: string): Severity | undefined {
  if (value === '') return undefined;
  if (value !== 'error' && value !== 'warn' && value !== 'advisory') {
    throw new ActionInputError('invalid severity input');
  }
  return value;
}

function parseMaxWarnings(value: string): number {
  if (value === '') return Number.POSITIVE_INFINITY;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ActionInputError('invalid max-warnings input');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ActionInputError('invalid max-warnings input');
  return parsed;
}

/**
 * Read GitHub Action inputs as data. Invalid values intentionally receive
 * generic messages so an attacker-controlled input is never echoed to logs.
 */
export function parseActionInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const workspaceInput = env.GITHUB_WORKSPACE;
  if (workspaceInput === undefined || workspaceInput === '') {
    throw new ActionInputError('GITHUB_WORKSPACE is required');
  }

  let workspace: string;
  let path: string;
  try {
    workspace = realpathSync(resolve(workspaceInput));
    path = realpathSync(resolve(workspace, input(env, 'PATH') || '.'));
    if (!statSync(workspace).isDirectory() || !statSync(path).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new ActionInputError('invalid path input');
  }
  if (!isWithinWorkspace(workspace, path))
    throw new ActionInputError('path must be within workspace');

  return {
    workspace,
    path,
    targets: parseTargets(input(env, 'TARGET')),
    severity: parseSeverity(input(env, 'SEVERITY')),
    maxWarnings: parseMaxWarnings(input(env, 'MAX-WARNINGS')),
  };
}
