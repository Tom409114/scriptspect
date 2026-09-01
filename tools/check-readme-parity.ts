import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = {
  status: resolve(root, 'docs/readme-status.json'),
  english: resolve(root, 'README.md'),
  chinese: resolve(root, 'README.zh-CN.md'),
};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument !== '--status' && argument !== '--english' && argument !== '--chinese') {
    throw new Error(`README parity: unknown option ${argument ?? ''}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.trim() === '') {
    throw new Error(`README parity: ${argument} needs a path`);
  }
  if (argument === '--status') paths.status = resolve(value);
  if (argument === '--english') paths.english = resolve(value);
  if (argument === '--chinese') paths.chinese = resolve(value);
  index += 1;
}
const englishPath = paths.english;
const chinesePath = paths.chinese;
const english = readFileSync(englishPath, 'utf8');
const chinese = readFileSync(chinesePath, 'utf8');

function fail(message: string): never {
  throw new Error(`README parity: ${message}`);
}

function captureAll(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map((match) => match[1] ?? match[0]).sort();
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

function equalField(name: string, extractor: (text: string) => string[]): void {
  const left = extractor(english);
  const right = extractor(chinese);
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${name} differ between languages`);
}

function localTargets(markdown: string): string[] {
  const targets = captureAll(markdown, /!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split('#', 1)[0] ?? '';
    if (clean.length === 0) continue;
    if (!existsSync(resolve(root, clean))) fail(`missing local target ${target}`);
  }
  return targets;
}

const languageSwitch = '[English](README.md) | [简体中文](README.zh-CN.md)';
if (!english.includes(languageSwitch) || !chinese.includes(languageSwitch))
  fail('language switches are not bidirectional');
if (!chinese.includes('English documentation'))
  fail('Chinese deep-document links need an English documentation label');

equalField('section keys', (text) => captureAll(text, /<!--\s*readme-section:\s*([^\s]+)\s*-->/g));
equalField('fenced blocks', (text) => captureAll(text, /```[^\n]*\n([\s\S]*?)```/g));
equalField('URLs', (text) => captureAll(text, /https?:\/\/[^\s)>]+/g));
equalField('versions', (text) => captureAll(text, /\bv?\d+\.\d+(?:\.\d+)?\b/g));
equalField('rule IDs', (text) => captureAll(text, /\bPS\d{3}\b/g));
equalField('demo assets', (text) => captureAll(text, /docs\/assets\/demo\/[\w.-]+/g));
localTargets(english);
localTargets(chinese);

const status = JSON.parse(readFileSync(paths.status, 'utf8')) as {
  releaseState: string;
  packageName: string;
  packageVersion: string;
  sourceCommit: string;
};
if (!/^[0-9a-f]{40}$/u.test(status.sourceCommit)) fail('source commit is not an exact SHA');
const renderCheck = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/tsx/dist/cli.mjs'),
    resolve(root, 'tools/render-readme-state.ts'),
    '--status',
    paths.status,
    '--english',
    englishPath,
    '--chinese',
    chinesePath,
    '--check',
  ],
  { cwd: root, encoding: 'utf8' },
);
if (renderCheck.status !== 0) {
  fail(renderCheck.stderr.trim() || renderCheck.stdout.trim() || 'homepage state render failed');
}

if (status.releaseState === 'pre-release') {
  for (const homepage of [english, chinese]) {
    if (!homepage.includes('Evaluate from source (pre-release)')) {
      fail('missing pre-release evaluation block');
    }
    if (
      fencedBlocks(homepage).some((block) =>
        /\b(?:npx\s+(?:--yes\s+)?scriptspect|pnpm\s+dlx\s+scriptspect)@?/u.test(block),
      )
    ) {
      fail('unpublished package command is present');
    }
    if (fencedBlocks(homepage).some((block) => /Tom409114\/scriptspect@v0\.1\b/.test(block))) {
      fail('nonexistent Action tag is present');
    }
  }
} else if (status.releaseState === 'published') {
  const escapedPackage = status.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedVersion = status.packageVersion.replace(/\./g, '\\.');
  for (const homepage of [english, chinese]) {
    if (homepage.includes('Evaluate from source (pre-release)')) {
      fail('published homepage still contains the pre-release evaluation block');
    }
    if (
      !fencedBlocks(homepage).some((block) =>
        new RegExp(`\\bnpx\\s+--yes\\s+${escapedPackage}@${escapedVersion}\\s+\\.`, 'u').test(
          block,
        ),
      )
    ) {
      fail('published homepage is missing the exact npm quick start');
    }
    if (
      !fencedBlocks(homepage).some((block) =>
        block.includes(`uses: Tom409114/scriptspect@v${status.packageVersion}`),
      )
    ) {
      fail('published homepage is missing the immutable Action release tag');
    }
  }
} else {
  fail(`unsupported release state ${status.releaseState}`);
}

console.log('README parity check passed');
