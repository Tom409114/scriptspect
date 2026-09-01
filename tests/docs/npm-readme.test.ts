import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const generator = resolve(root, 'tools/release/generate-package-readmes.mjs');
const sourceCommit = 'a'.repeat(40);

function generate(version: string) {
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-readme-'));
  const english = join(directory, 'README.md');
  const chinese = join(directory, 'README.zh-CN.md');
  const result = spawnSync(
    process.execPath,
    [
      tsx,
      generator,
      '--version',
      version,
      '--source-commit',
      sourceCommit,
      '--channel',
      version.includes('-bootstrap.') ? 'bootstrap' : 'stable',
      '--english',
      english,
      '--chinese',
      chinese,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return { directory, english, chinese, result };
}

describe('npm-only bilingual README generator', () => {
  it('generates attractive exact-version stable-package instructions without pre-release claims', () => {
    const generated = generate('0.1.0');
    try {
      expect(generated.result.status, generated.result.stderr).toBe(0);
      const english = readFileSync(generated.english, 'utf8');
      const chinese = readFileSync(generated.chinese, 'utf8');
      for (const readme of [english, chinese]) {
        expect(readme).toContain('npx --yes scriptspect@0.1.0 .');
        expect(readme).toContain('pnpm dlx scriptspect@0.1.0 .');
        expect(readme).toContain(`raw.githubusercontent.com/Tom409114/scriptspect/${sourceCommit}`);
        expect(readme).toContain('docs/assets/demo/terminal.svg');
        expect(readme).not.toContain('npm package and public Action tag do not exist yet');
        expect(readme).not.toContain('npm package 与公开 Action tag 尚不存在');
        expect(readme).not.toContain('pre-release source evaluation');
        expect(readme).not.toContain('/SECURITY.md');
        expect(readme).toContain('/security/advisories/new');
      }
      expect(english).toContain('uses: Tom409114/scriptspect@v0.1.0');
      expect(chinese).toContain('uses: Tom409114/scriptspect@v0.1.0');
      expect(english).toContain('Before, result, and after');
      expect(chinese).toContain('修复前、分析结果与修复后');
    } finally {
      rmSync(generated.directory, { recursive: true, force: true });
    }
  });

  it('labels bootstrap packages as prerelease ownership artifacts without a stable Action tag', () => {
    const generated = generate('0.0.0-bootstrap.7');
    try {
      expect(generated.result.status, generated.result.stderr).toBe(0);
      for (const path of [generated.english, generated.chinese]) {
        const readme = readFileSync(path, 'utf8');
        expect(readme).toContain('scriptspect@0.0.0-bootstrap.7');
        expect(readme).toContain('bootstrap');
        expect(readme).toContain('/.github/workflows/npm-bootstrap.yml');
        expect(readme).not.toContain('uses: Tom409114/scriptspect@v0.0.0-bootstrap.7');
      }
    } finally {
      rmSync(generated.directory, { recursive: true, force: true });
    }
  });

  it('links the bootstrap policy to a source-controlled file that exists', () => {
    expect(() =>
      readFileSync(resolve(root, '.github/workflows/npm-bootstrap.yml'), 'utf8'),
    ).not.toThrow();
  });

  it('fails closed for an invalid version or source commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scriptspect-npm-readme-invalid-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          tsx,
          generator,
          '--version',
          'latest',
          '--source-commit',
          'main',
          '--channel',
          'stable',
          '--english',
          join(directory, 'README.md'),
          '--chinese',
          join(directory, 'README.zh-CN.md'),
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
