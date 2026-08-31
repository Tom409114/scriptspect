/**
 * CLI integration tests through runCli with on-disk fixture projects in a
 * temp directory (exit codes 0/1/2, formats, config, path, filters).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function project(scripts: Record<string, string>, extra: Record<string, unknown> = {}): string {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts, ...extra }, null, 2),
  );
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-cli-'));
  outLines = [];
  errLines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI: default command and exit codes', () => {
  it('exit 0 on a clean project', async () => {
    project({ build: 'node build.js' });
    const code = await runCli([dir], io);
    expect(code).toBe(0);
    expect(outLines.join('\n')).toContain('0 errors');
  });

  it('exit 1 on a high-confidence error finding', async () => {
    project({ clean: 'rm -rf dist' });
    const code = await runCli([dir], io);
    expect(code).toBe(1);
    expect(outLines.join('\n')).toContain('PS010');
  });

  it('exit 2 when no package.json exists anywhere up the tree', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ss-empty-'));
    try {
      const code = await runCli([empty], io);
      expect(code).toBe(2);
      expect(errLines.join('\n')).toContain('no package.json');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('check subcommand equals the default command', async () => {
    project({ clean: 'rm -rf dist' });
    expect(await runCli(['check', dir], io)).toBe(1);
    expect(outLines.join('\n')).toContain('PS010');
  });

  it('uses cwd when no path is given', async () => {
    project({ build: 'node b.js' });
    const old = process.cwd();
    process.chdir(dir);
    try {
      expect(await runCli([], io)).toBe(0);
    } finally {
      process.chdir(old);
    }
  });

  it('walks up from a subdirectory to the project root', async () => {
    project({ clean: 'rm -rf dist' });
    mkdirSync(join(dir, 'src'));
    const old = process.cwd();
    process.chdir(join(dir, 'src'));
    try {
      const code = await runCli([], io);
      expect(code).toBe(1);
    } finally {
      process.chdir(old);
    }
  });
});

describe('CLI: options', () => {
  it('invalid --format exits 2', async () => {
    project({ build: 'node b.js' });
    expect(await runCli([dir, '--format', 'xml'], io)).toBe(2);
  });

  it('invalid --target exits 2', async () => {
    project({ clean: 'rm -rf dist' });
    expect(await runCli([dir, '--target', 'fish'], io)).toBe(2);
  });

  it('--target can exclude cmd so rm findings disappear', async () => {
    project({ clean: 'rm -rf dist' });
    const code = await runCli([dir, '--target', 'posix-sh'], io);
    expect(code).toBe(0);
    expect(outLines.join('\n')).not.toContain('PS010');
  });

  it('--rule restricts execution to given rules', async () => {
    project({ a: 'rm -rf dist && NODE_ENV=x v' });
    await runCli([dir, '--rule', 'PS001'], io);
    const text = outLines.join('\n');
    expect(text).toContain('PS001');
    expect(text).not.toContain('PS010');
  });

  it('unknown rule id in --rule exits 2', async () => {
    project({ a: 'node x' });
    expect(await runCli([dir, '--rule', 'PS999'], io)).toBe(2);
  });

  it('--severity error hides warnings but they still do not fail', async () => {
    project({ a: 'chmod +x f' });
    const code = await runCli([dir, '--severity', 'error'], io);
    expect(code).toBe(0);
    expect(outLines.join('\n')).not.toContain('PS015');
  });

  it('--max-warnings fails the run above the threshold', async () => {
    project({ a: 'chmod +x f', b: 'chmod +x g' });
    expect(await runCli([dir, '--max-warnings', '1'], io)).toBe(1);
    expect(await runCli([dir, '--max-warnings', '2'], io)).toBe(0);
  });

  it('--max-warnings rejects non-integers', async () => {
    project({ a: 'node x' });
    expect(await runCli([dir, '--max-warnings', 'abc'], io)).toBe(2);
  });

  it('--quiet still prints findings and summary', async () => {
    project({ clean: 'rm -rf dist' });
    await runCli([dir, '--quiet'], io);
    const text = outLines.join('\n');
    expect(text).toContain('PS010');
    expect(text).toContain('Scanned 1 script');
  });
});

describe('CLI: formats', () => {
  it('--format json emits parseable JSON with findings', async () => {
    project({ clean: 'rm -rf dist' });
    await runCli([dir, '--format', 'json'], io);
    const parsed = JSON.parse(outLines.join('\n'));
    expect(parsed.findings[0].ruleId).toBe('PS010');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('--format github emits annotations', async () => {
    project({ clean: 'rm -rf dist' });
    await runCli([dir, '--format', 'github'], io);
    expect(outLines.join('\n')).toMatch(/::error file=package\.json/);
  });

  it('config file is honored (severity override + ignore)', async () => {
    project(
      { a: 'rm -rf dist', b: 'chmod +x f' },
      {
        scriptspect: {
          severity: { PS015: 'advisory' },
          ignore: [{ scripts: ['a'], rules: ['PS010'] }],
        },
      },
    );
    const code = await runCli([dir, '--format', 'json'], io);
    const parsed = JSON.parse(outLines.join('\n'));
    expect(code).toBe(0); // PS010 ignored, PS015 downgraded to advisory
    expect(parsed.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(['PS015']);
    expect(parsed.findings[0].severity).toBe('advisory');
  });

  it('broken config JSON exits 2 with a message', async () => {
    project({ a: 'node x' });
    writeFileSync(join(dir, 'scriptspect.config.json'), '{ nope');
    // package.json has no scriptspect field, so the broken file is picked up
    expect(await runCli([dir], io)).toBe(2);
    expect(errLines.join('\n')).toContain('scriptspect.config.json');
  });
});

describe('CLI: explain', () => {
  it('explains a rule offline', async () => {
    const code = await runCli(['explain', 'PS010'], io);
    expect(code).toBe(0);
    const text = outLines.join('\n');
    expect(text).toContain('PS010 · POSIX_RM');
    expect(text).toContain('Bad examples');
    expect(text).toContain('Provenance');
  });

  it('explain accepts lowercase rule ids', async () => {
    expect(await runCli(['explain', 'ps010'], io)).toBe(0);
  });

  it('explain of an unknown rule exits 2', async () => {
    expect(await runCli(['explain', 'PS999'], io)).toBe(2);
  });
});
