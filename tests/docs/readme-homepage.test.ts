import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '../../tools/release/release-state.mjs';

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

describe('bilingual homepage', () => {
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

  it('keeps generated release status outside the capability table', () => {
    for (const homepage of [read('README.md'), read('README.zh-CN.md')]) {
      expect(homepage).not.toMatch(/<!-- readme-state:release-row:start -->\n\| Release \|/u);
      expect(homepage).toMatch(/<!-- readme-state:release-row:start -->\n\*\*Release:\*\*/u);
    }
  });

  it('presents only commands supported by the recorded release state', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const status = JSON.parse(read('docs/readme-status.json')) as {
      releaseState: string;
      sourceCommit: string;
    };

    expect(status.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    for (const homepage of [english, chinese]) {
      expect(homepage).not.toMatch(/All milestones.*merged/i);
      expect(homepage).not.toMatch(/production[- ]ready/i);
      if (status.releaseState === 'pre-release') {
        expect(homepage).toContain('Evaluate from source (pre-release)');
        expect(
          fencedBlocks(homepage).some((block) =>
            /\b(?:npx\s+(?:--yes\s+)?scriptspect|pnpm\s+dlx\s+scriptspect)@?/u.test(block),
          ),
        ).toBe(false);
        expect(
          fencedBlocks(homepage).some((block) => /Tom409114\/scriptspect@v0\.1\b/.test(block)),
        ).toBe(false);
        expect(homepage).toContain(`git checkout ${status.sourceCommit}`);
        expect(homepage).toContain(`ref: ${status.sourceCommit}`);
      }
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
      annotations: Array<{ title: string; displayTitle?: string; message: string }>;
    };

    expect(evidence.sourceCommit).toBe('bf37b4132508c685a91cc16a9c0a3058c252502e');
    expect(evidence.workflowRun).toEqual(
      expect.objectContaining({
        id: 33467290054,
        conclusion: 'success',
        url: 'https://github.com/Tom409114/scriptspect/actions/runs/33467290054',
      }),
    );
    expect(evidence.checkRun).toEqual(
      expect.objectContaining({ id: 99729679961, annotationCount: 2 }),
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
    expect(evidence.annotations).toContainEqual(
      expect.objectContaining({
        title: '',
        displayTitle: 'Action failure contract',
        message: 'scriptspect action failed',
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
      expect(homepage).toContain('33467290054');
      expect(homepage).toContain('bf37b413');
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

  it('renders a published bilingual homepage from an explicit verified release state', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'scriptspect-readme-state-'));
    const englishPath = join(temporaryRoot, 'README.md');
    const chinesePath = join(temporaryRoot, 'README.zh-CN.md');
    const statusPath = join(temporaryRoot, 'readme-status.json');
    const receiptDirectory = join(temporaryRoot, 'validation', 'releases', 'v0.1.0');
    const receiptPath = join(receiptDirectory, 'readme-release-receipt.json');
    copyFileSync(resolve(root, 'README.md'), englishPath);
    copyFileSync(resolve(root, 'README.zh-CN.md'), chinesePath);
    const finalVerification = {
      schemaVersion: 'scriptspect-final-verification/v1',
      intentId: 'scriptspect-release-intent:62:bf37b4132508c685a91cc16a9c0a3058c252502e',
      version: '0.1.0',
      tag: 'v0.1.0',
      commit: 'bf37b4132508c685a91cc16a9c0a3058c252502e',
      releaseId: 123456,
      candidateManifestDigest: 'a'.repeat(64),
      releaseManifestDigest: 'b'.repeat(64),
      candidateNpmSRI: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      registryNpmSRI: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      provenanceDigest: 'c'.repeat(64),
      aliases: [
        { name: 'v0.1', target: 'bf37b4132508c685a91cc16a9c0a3058c252502e' },
        { name: 'v0', target: 'bf37b4132508c685a91cc16a9c0a3058c252502e' },
      ],
    };
    const receipt = {
      schemaVersion: 'scriptspect-readme-release-receipt/v1',
      repository: 'https://github.com/Tom409114/scriptspect',
      intentCheckRunId: 123456789,
      finalVerificationAssetId: 987654321,
      finalVerificationDigest: canonicalJsonDigest(finalVerification),
      publishRunId: 123456790,
      finalVerification,
    };
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          releaseState: 'published',
          packageName: 'scriptspect',
          packageVersion: '0.1.0',
          sourceCommit: 'bf37b4132508c685a91cc16a9c0a3058c252502e',
          nodeMajor: 22,
          repository: 'https://github.com/Tom409114/scriptspect',
          releaseEvidence: {
            receiptPath: 'validation/releases/v0.1.0/readme-release-receipt.json',
            digest: canonicalJsonDigest(receipt),
          },
        },
        null,
        2,
      )}\n`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/tsx/dist/cli.mjs'),
          resolve(root, 'tools/render-readme-state.ts'),
          '--status',
          statusPath,
          '--english',
          englishPath,
          '--chinese',
          chinesePath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);

      const english = readFileSync(englishPath, 'utf8');
      const chinese = readFileSync(chinesePath, 'utf8');
      for (const homepage of [english, chinese]) {
        expect(homepage).toContain('npx --yes scriptspect@0.1.0 .');
        expect(homepage).toContain('pnpm dlx scriptspect@0.1.0 .');
        expect(homepage).toContain('uses: Tom409114/scriptspect@v0.1.0');
        expect(homepage).toContain('bf37b4132508c685a91cc16a9c0a3058c252502e');
        expect(homepage).not.toContain('Evaluate from source (pre-release)');
      }
      expect(english).toContain('Verified release');
      expect(english).not.toContain('Latest verified release');
      expect(english).not.toContain('npm package and public Action tag do not exist yet');
      expect(english).toContain('| Area | Current behavior |');
      expect(english).not.toContain('Current source-evaluation behavior');
      expect(chinese).toContain('已验证 release');
      expect(chinese).not.toContain('最新已验证 release');
      expect(chinese).not.toContain('npm package 与公开 Action tag 尚不存在');
      expect(chinese).toContain('| 范围 | 当前行为 |');
      expect(chinese).not.toContain('当前源码评估行为');

      const pristineParity = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/tsx/dist/cli.mjs'),
          resolve(root, 'tools/check-readme-parity.ts'),
          '--status',
          statusPath,
          '--english',
          englishPath,
          '--chinese',
          chinesePath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(pristineParity.status, pristineParity.stderr).toBe(0);
      expect(pristineParity.stdout).toContain('README parity check passed');

      writeFileSync(englishPath, english.replace('scriptspect@0.1.0 .', 'scriptspect@9.9.9 .'));
      writeFileSync(chinesePath, chinese.replace('scriptspect@0.1.0 .', 'scriptspect@9.9.9 .'));
      const staleCheck = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/tsx/dist/cli.mjs'),
          resolve(root, 'tools/check-readme-parity.ts'),
          '--status',
          statusPath,
          '--english',
          englishPath,
          '--chinese',
          chinesePath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(staleCheck.status).not.toBe(0);
      expect(staleCheck.stderr).toContain('homepage is stale for published');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('refuses a published homepage without terminal release evidence', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'scriptspect-readme-unverified-'));
    const englishPath = join(temporaryRoot, 'README.md');
    const chinesePath = join(temporaryRoot, 'README.zh-CN.md');
    const statusPath = join(temporaryRoot, 'readme-status.json');
    copyFileSync(resolve(root, 'README.md'), englishPath);
    copyFileSync(resolve(root, 'README.zh-CN.md'), chinesePath);
    writeFileSync(
      statusPath,
      `${JSON.stringify({
        schemaVersion: 1,
        releaseState: 'published',
        packageName: 'scriptspect',
        packageVersion: '0.1.0',
        sourceCommit: 'bf37b4132508c685a91cc16a9c0a3058c252502e',
        nodeMajor: 22,
        repository: 'https://github.com/Tom409114/scriptspect',
      })}\n`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/tsx/dist/cli.mjs'),
          resolve(root, 'tools/render-readme-state.ts'),
          '--status',
          statusPath,
          '--english',
          englishPath,
          '--chinese',
          chinesePath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('terminal release evidence');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('refuses to mark the homepage published from a version bump alone', () => {
    const before = read('docs/readme-status.json');
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        resolve(root, 'tools/generate-readme-status.ts'),
        'HEAD',
        '--published',
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      version === '0.0.0'
        ? 'published README state requires a nonzero released version'
        : 'published README state requires --receipt terminal evidence',
    );
    expect(read('docs/readme-status.json')).toBe(before);
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
    expect(terminalSvg).toContain('<title id="title">ScriptSpect demo output</title>');
    expect(terminalSvg).not.toContain('pre-release demo output');
    expect(terminalSvg).toContain('class="terminal-line terminal-error"');
    expect(terminalSvg).toContain('class="terminal-line terminal-advisory"');
    expect(terminalSvg).toContain('class="terminal-line terminal-command"');
    const renderedColumnCounts = [...terminalSvg.matchAll(/data-columns="([0-9]+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(renderedColumnCounts.length).toBeGreaterThan(terminal.split('\n').length);
    expect(Math.max(...renderedColumnCounts)).toBeLessThanOrEqual(104);
    const actionText = read('docs/assets/demo/action.txt');
    expect(actionText).toContain('workflow run: 33467290054 (success)');
    expect(actionText).toContain('source commit: bf37b4132508c685a91cc16a9c0a3058c252502e');
    expect(actionText).toContain('broken fixture: 2 annotations');
    expect(actionText).toContain('PS010: scripts.clean');
    const actionSvg = read('docs/assets/demo/action.svg');
    expect(actionSvg).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/);
    expect(actionSvg).toContain('Hosted Action evidence');
    expect(actionSvg).toContain('data-run-id="33467290054"');
    expect(actionSvg).not.toMatch(/<script|(?:href|src)=["']https?:\/\//iu);
    const patch = read('docs/assets/demo/fix.patch');
    expect(patch).toContain('--- a/package.json');
    expect(patch).not.toContain('Scanned ');
    const after = read('docs/assets/demo/package.after.json');
    expect(after).toContain('cross-env NODE_ENV=production vite build');
    expect(after).toContain('rimraf dist');
  });
});
