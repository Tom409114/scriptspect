import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({
  lstatErrorCode: undefined as string | undefined,
  lstatFailureSuffix: '/pnpm-workspace.yaml',
  realpathFailureSuffix: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const normalized = (path: Parameters<typeof actual.lstatSync>[0]): string =>
    String(path).replace(/\\/g, '/');
  const failure = (
    operation: 'lstat' | 'realpath',
    path: Parameters<typeof actual.lstatSync>[0],
    code: string,
  ): NodeJS.ErrnoException => {
    const error = new Error(
      `${code}: injected workspace filesystem failure, ${operation} '${String(path)}'`,
    ) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  return {
    ...actual,
    lstatSync(
      path: Parameters<typeof actual.lstatSync>[0],
      options?: Parameters<typeof actual.lstatSync>[1],
    ) {
      if (
        injected.lstatErrorCode !== undefined &&
        normalized(path).endsWith(injected.lstatFailureSuffix)
      ) {
        throw failure('lstat', path, injected.lstatErrorCode);
      }
      return actual.lstatSync(path, options as never);
    },
    realpathSync(
      path: Parameters<typeof actual.realpathSync>[0],
      options?: Parameters<typeof actual.realpathSync>[1],
    ) {
      if (
        injected.realpathFailureSuffix !== undefined &&
        normalized(path).endsWith(injected.realpathFailureSuffix)
      ) {
        throw failure('realpath', path, 'EACCES');
      }
      return actual.realpathSync(path, options as never);
    },
  };
});

import type { CliIo } from '../../src/cli/index';
import { runCli } from '../../src/cli/index';
import { AnalyzeError } from '../../src/core/analyze';
import { discoverPackages } from '../../src/workspaces/discover';

let root: string;
let output: string[];
let errors: string[];

function packageJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'fixture', scripts: { build: 'node build.js' }, ...extra });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ss-workspace-errors-'));
  writeFileSync(join(root, 'package.json'), packageJson());
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  injected.lstatErrorCode = undefined;
  injected.lstatFailureSuffix = '/pnpm-workspace.yaml';
  injected.realpathFailureSuffix = undefined;
  output = [];
  errors = [];
});

afterEach(() => {
  injected.lstatErrorCode = undefined;
  injected.lstatFailureSuffix = '/pnpm-workspace.yaml';
  injected.realpathFailureSuffix = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('workspace manifest filesystem failures', () => {
  it.each(['EACCES', 'EPERM', 'EIO'])(
    'fails closed when inspecting pnpm-workspace.yaml raises %s',
    (code) => {
      injected.lstatErrorCode = code;

      expect(() => discoverPackages(root)).toThrow(AnalyzeError);
      expect(() => discoverPackages(root)).toThrow(
        new RegExp(`pnpm-workspace\\.yaml.*${code}`, 'i'),
      );
    },
  );

  it('returns CLI exit 2 when workspace manifest inspection is denied', async () => {
    injected.lstatErrorCode = 'EACCES';
    const io: CliIo = {
      out: (message) => output.push(message),
      err: (message) => errors.push(message),
    };

    expect(await runCli([root], io)).toBe(2);
    expect(output).toEqual([]);
    expect(errors.join('\n')).toMatch(/pnpm-workspace\.yaml.*EACCES/i);
  });

  it('fails closed when inspecting a matched package manifest is denied', () => {
    writeFileSync(join(root, 'package.json'), packageJson({ workspaces: ['packages/*'] }));
    mkdirSync(join(root, 'packages', 'app'), { recursive: true });
    writeFileSync(join(root, 'packages', 'app', 'package.json'), packageJson());
    injected.lstatErrorCode = 'EACCES';
    injected.lstatFailureSuffix = '/packages/app/package.json';

    expect(() => discoverPackages(root)).toThrow(AnalyzeError);
    expect(() => discoverPackages(root)).toThrow(/packages[/\\]app[/\\]package\.json.*EACCES/i);
  });

  it('preserves the path and cause when canonicalizing the pnpm manifest fails', () => {
    injected.realpathFailureSuffix = '/pnpm-workspace.yaml';

    expect(() => discoverPackages(root)).toThrow(AnalyzeError);
    expect(() => discoverPackages(root)).toThrow(/pnpm-workspace\.yaml.*EACCES/i);
    expect(() => discoverPackages(root)).not.toThrow(/outside the project root/i);
  });

  it('does not downgrade workspace directory canonicalization failures to skip notes', () => {
    writeFileSync(join(root, 'package.json'), packageJson({ workspaces: ['packages/*'] }));
    mkdirSync(join(root, 'packages', 'app'), { recursive: true });
    writeFileSync(join(root, 'packages', 'app', 'package.json'), packageJson());
    injected.realpathFailureSuffix = '/packages/app';

    expect(() => discoverPackages(root)).toThrow(AnalyzeError);
    expect(() => discoverPackages(root)).toThrow(/packages[/\\]app.*EACCES/i);
  });
});
