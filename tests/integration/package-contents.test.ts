import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackFile {
  path: string;
}

interface PackResult {
  files: PackFile[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function packDryRun(): string {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
      cwd: root,
      encoding: 'utf8',
    });
  }
  return execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('published package contents', () => {
  it('ships both schemas and both README languages', () => {
    const raw = packDryRun();
    const [pack] = JSON.parse(raw) as PackResult[];
    const paths = pack?.files.map((file) => file.path) ?? [];

    expect(paths).toContain('schema/config.schema.json');
    expect(paths).toContain('schema/output.schema.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('README.zh-CN.md');
  }, 60_000);
});
