import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const englishPath = resolve(root, 'README.md');
const chinesePath = resolve(root, 'README.zh-CN.md');
const english = readFileSync(englishPath, 'utf8');
const chinese = readFileSync(chinesePath, 'utf8');

function fail(message: string): never {
  throw new Error(`README parity: ${message}`);
}

function setOf(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function captureAll(text: string, expression: RegExp): string[] {
  return setOf([...text.matchAll(expression)].map((match) => match[1] ?? match[0]));
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

function equalField(name: string, extractor: (text: string) => string[]): void {
  const left = extractor(english);
  const right = extractor(chinese);
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${name} differ between languages`);
}

function localTargets(markdown: string, source: string): string[] {
  const targets = captureAll(markdown, /!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split('#', 1)[0] ?? '';
    if (clean.length === 0) continue;
    if (!existsSync(resolve(dirname(source), clean))) fail(`missing local target ${target}`);
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
localTargets(english, englishPath);
localTargets(chinese, chinesePath);

const status = JSON.parse(readFileSync(resolve(root, 'docs/readme-status.json'), 'utf8')) as {
  releaseState: string;
};
if (status.releaseState !== 'pre-release') fail(`unsupported release state ${status.releaseState}`);
for (const homepage of [english, chinese]) {
  if (!homepage.includes('Evaluate from source (pre-release)'))
    fail('missing pre-release evaluation block');
  if (fencedBlocks(homepage).some((block) => /\bnpx\s+scriptspect\b/.test(block))) {
    fail('unpublished npx command is present');
  }
  if (fencedBlocks(homepage).some((block) => /Tom409114\/scriptspect@v0\.1\b/.test(block))) {
    fail('nonexistent Action tag is present');
  }
}

console.log('README parity check passed');
