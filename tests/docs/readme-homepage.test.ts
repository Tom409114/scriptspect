import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const runTool = (tool: string): string =>
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, tool)],
    { cwd: root, encoding: 'utf8' },
  );
const fencedBlocks = (markdown: string): string[] =>
  [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

describe('bilingual pre-release homepage', () => {
  it('uses one accessible, self-contained brand hero and only truthful badges', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const hero = read('docs/assets/brand/hero.svg');

    for (const homepage of [english, chinese]) {
      expect(homepage).toContain('docs/assets/brand/hero.svg');
      expect(homepage).toContain('actions/workflows/ci.yml/badge.svg?branch=main');
      expect(homepage).toContain('license-MIT');
      expect(homepage).not.toMatch(/badge[^\n]*(?:stars|downloads|precision|production)/iu);
    }
    expect(hero).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/u);
    expect(hero).toContain('<title id="title">');
    expect(hero).toContain('<desc id="desc">');
    expect(hero).not.toMatch(/<script|(?:href|src)=["']https?:\/\//iu);
  });

  it('does not present an unpublished package or Action release as usable', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const status = JSON.parse(read('docs/readme-status.json')) as { releaseState: string };

    expect(status.releaseState).toBe('pre-release');
    for (const homepage of [english, chinese]) {
      expect(homepage).toContain('Evaluate from source (pre-release)');
      expect(fencedBlocks(homepage).some((block) => /\bnpx\s+scriptspect\b/.test(block))).toBe(
        false,
      );
      expect(
        fencedBlocks(homepage).some((block) => /Tom409114\/scriptspect@v0\.1\b/.test(block)),
      ).toBe(false);
      expect(homepage).not.toMatch(/All milestones.*merged/i);
      expect(homepage).not.toMatch(/production[- ]ready/i);
    }
  });

  it('links English and Simplified Chinese pages in both directions', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');

    expect(english).toContain('[English](README.md) | [简体中文](README.zh-CN.md)');
    expect(chinese).toContain('[English](README.md) | [简体中文](README.zh-CN.md)');
    expect(chinese).toContain('English documentation');
  });

  it('keeps stable commands, URLs, rule IDs, sections, and assets in parity', () => {
    expect(runTool('tools/check-readme-parity.ts')).toContain('README parity check passed');
  });
});

describe('README demo artifacts', () => {
  const artifacts = [
    'docs/assets/demo/package.before.json',
    'docs/assets/demo/terminal.txt',
    'docs/assets/demo/fix.patch',
    'docs/assets/demo/package.after.json',
    'docs/assets/demo/terminal.svg',
  ];

  it('are deterministically generated from one fixture with accessible, ANSI-free output', () => {
    const first = runTool('tools/generate-readme-demo.ts');
    expect(first).toContain('README demo artifacts generated');
    const before = new Map(
      artifacts.map((path) => [path, createHash('sha256').update(read(path)).digest('hex')]),
    );
    const second = runTool('tools/generate-readme-demo.ts');
    expect(second).toContain('README demo artifacts generated');

    for (const path of artifacts) {
      expect(existsSync(resolve(root, path))).toBe(true);
      expect(createHash('sha256').update(read(path)).digest('hex')).toBe(before.get(path));
    }

    const terminal = read('docs/assets/demo/terminal.txt');
    expect(terminal).not.toContain('\u001B');
    expect(terminal).toContain('PS001');
    expect(terminal).toContain('PS010');
    expect(terminal).toContain('exit code: 1');
    expect(read('docs/assets/demo/terminal.svg')).toMatch(
      /<svg[^>]+role="img"[^>]+aria-labelledby=/,
    );
    const patch = read('docs/assets/demo/fix.patch');
    expect(patch).toContain('--- a/package.json');
    expect(patch).not.toContain('Scanned ');
    const after = read('docs/assets/demo/package.after.json');
    expect(after).toContain('cross-env NODE_ENV=production vite build');
    expect(after).toContain('rimraf dist');
  });
});
