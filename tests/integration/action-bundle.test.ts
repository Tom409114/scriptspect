import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nonBuiltinBareImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const importSpecifiers = [
    ...source.matchAll(/^\s*import\s+[^'"\r\n]*?\sfrom\s+['"]([^'"]+)['"];/gmu),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"];/gmu),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return importSpecifiers.filter((specifier) => !builtins.has(specifier));
}

function runBundle(scripts: Record<string, string>, throughAlias = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-action-bundle-')));
  roots.push(root);
  const manifest = `${JSON.stringify({ name: 'bundle-consumer', scripts }, null, 2)}\n`;
  writeFileSync(join(root, 'package.json'), manifest);
  const output = join(root, 'github-output');
  const summary = join(root, 'github-summary');
  const bundle = join(root, 'action.mjs');
  copyFileSync(resolve('dist/action.mjs'), bundle);
  let entry = bundle;
  if (throughAlias) {
    const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-action-alias-')));
    roots.push(aliasParent);
    const alias = join(aliasParent, 'workspace');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    entry = join(alias, 'action.mjs');
  }
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    encoding: 'utf8',
    env: {
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_PATH: '.',
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    },
  });
  return { root, manifest, output, summary, result };
}

describe('committed GitHub Action bundle', () => {
  it('has no bare imports except Node builtins', () => {
    expect(nonBuiltinBareImports(resolve('dist/action.mjs'))).toEqual([]);
  });

  it('keeps the CLI production dependencies external', () => {
    expect(nonBuiltinBareImports(resolve('dist/cli.mjs'))).toEqual([
      'cac',
      'semver',
      'fast-glob',
      'yaml',
      'picocolors',
    ]);
  });

  it('emits annotations, summary, and numeric outputs before failing without changing the repo', () => {
    const run = runBundle({ clean: 'rm -rf dist' });

    expect(run.result.status).toBe(1);
    expect(run.result.stdout).toContain('::error file=package.json,title=PS010');
    expect(run.result.stderr).toContain('::error::scriptspect action failed');
    expect(readFileSync(run.output, 'utf8').trim().split(/\r?\n/u)).toEqual([
      'exit-code=1',
      'packages=1',
      'scripts=1',
      'errors=1',
      'warnings=0',
      'advisories=0',
    ]);
    expect(readFileSync(run.summary, 'utf8')).toContain('## scriptspect');
    expect(readFileSync(join(run.root, 'package.json'), 'utf8')).toBe(run.manifest);
  });

  it('succeeds for a clean fixture through the generated bundle', () => {
    const run = runBundle({ build: 'node build.js' });

    expect(run.result.status).toBe(0);
    expect(readFileSync(run.output, 'utf8')).toContain('exit-code=0');
    expect(readFileSync(run.summary, 'utf8')).toContain('Scanned **1 script**');
  });

  it('runs when the bundle entrypoint is reached through a filesystem alias', () => {
    const run = runBundle({ build: 'node build.js' }, true);

    expect(run.result.status).toBe(0);
    expect(readFileSync(run.output, 'utf8')).toContain('exit-code=0');
  });
});
