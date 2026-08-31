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
  it('uses responsive, accessible, self-contained brand heroes and only truthful badges', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const hero = read('docs/assets/brand/hero.svg');
    const mobileHero = read('docs/assets/brand/hero-mobile.svg');

    for (const homepage of [english, chinese]) {
      expect(homepage).toContain('docs/assets/brand/hero.svg');
      expect(homepage).toContain('<picture>');
      expect(homepage).toContain('media="(max-width: 700px)"');
      expect(homepage).toContain('docs/assets/brand/hero-mobile.svg');
      expect(homepage).toContain('actions/workflows/ci.yml/badge.svg?branch=main');
      expect(homepage).toContain('license-MIT');
      expect(homepage).not.toMatch(/badge[^\n]*(?:stars|downloads|precision|production)/iu);
    }
    for (const artwork of [hero, mobileHero]) {
      expect(artwork).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/u);
      expect(artwork).toContain('<title id="title">');
      expect(artwork).toContain('<desc id="desc">');
      expect(artwork).not.toMatch(/<script|(?:href|src)=["']https?:\/\//iu);
      expect(artwork).not.toContain('<filter');
    }
  });

  it('does not present an unpublished package or Action release as usable', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const status = JSON.parse(read('docs/readme-status.json')) as {
      releaseState: string;
      sourceCommit: string;
    };

    expect(status.releaseState).toBe('pre-release');
    expect(status.sourceCommit).toBe('0898538abef5b054db6a20dc0ffe7fb9bb67e96b');
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
      expect(homepage).toContain(`git checkout ${status.sourceCommit}`);
      expect(homepage).toContain(`ref: ${status.sourceCommit}`);
    }
  });

  it('leads with the executable demo and links real hosted Action evidence', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const evidence = JSON.parse(read('docs/validation/readme-action-evidence.json')) as {
      sourceCommit: string;
      workflowRun: { id: number; url: string; conclusion: string };
      checkRun: { id: number; annotationCount: number };
      cleanConsumer: { exitCode: number; packages: number; scripts: number; errors: number };
      annotations: Array<{ title: string; message: string }>;
    };

    expect(evidence.sourceCommit).toBe('0898538abef5b054db6a20dc0ffe7fb9bb67e96b');
    expect(evidence.workflowRun).toEqual(
      expect.objectContaining({
        id: 33449906358,
        conclusion: 'success',
        url: 'https://github.com/Tom409114/scriptspect/actions/runs/33449906358',
      }),
    );
    expect(evidence.checkRun).toEqual(
      expect.objectContaining({ id: 99677215357, annotationCount: 2 }),
    );
    expect(evidence.cleanConsumer).toEqual(
      expect.objectContaining({ exitCode: 0, packages: 1, scripts: 1, errors: 0 }),
    );
    expect(evidence.annotations).toContainEqual(
      expect.objectContaining({
        title: 'PS010: scripts.clean',
        message:
          '`rm -rf` is not available in native Windows npm scripts · affected%3A cmd · scripts.clean',
      }),
    );

    for (const homepage of [english, chinese]) {
      expect(homepage.indexOf('<!-- readme-section: demo -->')).toBeLessThan(
        homepage.indexOf('<!-- readme-section: evaluate -->'),
      );
      expect(homepage).toContain('docs/assets/demo/action.svg');
      expect(homepage).toContain('docs/assets/demo/action.txt');
      expect(homepage).toContain('docs/validation/readme-action-evidence.json');
      expect(homepage).toContain(evidence.workflowRun.url);
      expect(homepage).toContain('33449906358');
      expect(homepage).toContain('0898538');
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
    'docs/assets/demo/action.txt',
    'docs/assets/demo/action.svg',
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
    const terminalSvg = read('docs/assets/demo/terminal.svg');
    expect(terminalSvg).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/);
    expect(terminalSvg).toContain('class="terminal-line terminal-error"');
    expect(terminalSvg).toContain('class="terminal-line terminal-advisory"');
    expect(terminalSvg).toContain('class="terminal-line terminal-command"');
    const renderedColumnCounts = [...terminalSvg.matchAll(/data-columns="([0-9]+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(renderedColumnCounts.length).toBeGreaterThan(terminal.split('\n').length);
    expect(Math.max(...renderedColumnCounts)).toBeLessThanOrEqual(104);
    const actionText = read('docs/assets/demo/action.txt');
    expect(actionText).toContain('workflow run: 33449906358 (success)');
    expect(actionText).toContain('source commit: 0898538abef5b054db6a20dc0ffe7fb9bb67e96b');
    expect(actionText).toContain('broken fixture: 2 annotations');
    expect(actionText).toContain('PS010: scripts.clean');
    const actionSvg = read('docs/assets/demo/action.svg');
    expect(actionSvg).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/);
    expect(actionSvg).toContain('Hosted Action evidence');
    expect(actionSvg).toContain('data-run-id="33449906358"');
    expect(actionSvg).not.toMatch(/<script|(?:href|src)=["']https?:\/\//iu);
    const patch = read('docs/assets/demo/fix.patch');
    expect(patch).toContain('--- a/package.json');
    expect(patch).not.toContain('Scanned ');
    const after = read('docs/assets/demo/package.after.json');
    expect(after).toContain('cross-env NODE_ENV=production vite build');
    expect(after).toContain('rimraf dist');
  });
});
