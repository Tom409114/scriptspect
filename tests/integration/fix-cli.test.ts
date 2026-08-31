/**
 * CLI integration tests for --fix / --fix-dry-run (spec §7, §4.3).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../../src/cli/index';
import { runCli } from '../../src/cli/index';

let dir: string;
let outLines: string[];
let errLines: string[];
const io: CliIo = {
  out: (t) => outLines.push(t),
  err: (t) => errLines.push(t),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-fixcli-'));
  outLines = [];
  errLines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function project(scripts: Record<string, string>, deps: Record<string, string> = {}): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts, devDependencies: deps }, null, 2),
  );
}

describe('CLI --fix-dry-run', () => {
  it('prints a unified patch and leaves the file untouched', async () => {
    project({ clean: 'rm -rf dist' }, { rimraf: '^5' });
    const code = await runCli([dir, '--fix-dry-run'], io);
    const text = outLines.join('\n');
    expect(text).toContain('--- a/package.json (scripts.clean)');
    expect(text).toContain('-rm -rf dist');
    expect(text).toContain('+rimraf dist');
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('rm -rf dist');
    // the finding still exists during a dry-run: exit code stays 1
    expect(code).toBe(1);
  });

  it('reports when no safe fixes are available', async () => {
    project({ clean: 'rm -rf dist' }); // no rimraf/shx dependency
    const code = await runCli([dir, '--fix-dry-run'], io);
    expect(code).toBe(1);
    expect(errLines.join('\n')).toContain('no safe fixes available');
    expect(outLines.join('\n')).not.toContain('+++');
  });
});

describe('CLI --fix', () => {
  it('applies safe fixes and re-analyzes to a clean exit code', async () => {
    project(
      { clean: 'rm -rf dist', build: 'NODE_ENV=x vite build' },
      { rimraf: '^5', 'cross-env': '^7', vite: '^5' },
    );
    const code = await runCli([dir, '--fix'], io);
    const after = readFileSync(join(dir, 'package.json'), 'utf8');
    expect(after).toContain('"clean": "rimraf dist"');
    expect(after).toContain('"build": "cross-env NODE_ENV=x vite build"');
    expect(errLines.join('\n')).toContain('fixed 2 script(s)');
    expect(code).toBe(0);
  });

  it('preserves formatting and field order when writing', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      `{
    "name": "fixture",
    "version": "1.0.0",
    "scripts": {
        "clean": "rm -rf dist"
    },
    "private": true,
    "devDependencies": {
        "rimraf": "^5.0.0"
    }
}
`,
    );
    await runCli([dir, '--fix'], io);
    const after = readFileSync(join(dir, 'package.json'), 'utf8');
    expect(after).toContain('"clean": "rimraf dist"');
    expect(after).toContain('"private": true');
    expect(after).toContain('"version": "1.0.0"');
    expect(after).toContain('\n    "scripts"'); // 4-space indent preserved
  });

  it('never touches the file when dependencies are missing', async () => {
    project({ clean: 'rm -rf dist' });
    const code = await runCli([dir, '--fix'], io);
    expect(code).toBe(1);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('rm -rf dist');
    expect(errLines.join('\n')).toContain('no safe fixes available');
  });

  it('is idempotent across runs', async () => {
    project({ clean: 'rm -rf dist' }, { rimraf: '^5' });
    await runCli([dir, '--fix'], io);
    const once = readFileSync(join(dir, 'package.json'), 'utf8');
    outLines = [];
    errLines = [];
    await runCli([dir, '--fix'], io);
    const twice = readFileSync(join(dir, 'package.json'), 'utf8');
    expect(twice).toBe(once);
    expect(errLines.join('\n')).toContain('no safe fixes available');
  });
});
