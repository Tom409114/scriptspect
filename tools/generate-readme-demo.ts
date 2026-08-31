import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = resolve(root, 'tests/fixtures/readme-demo/package.json');
const outputDir = resolve(root, 'docs/assets/demo');
const before = readFileSync(fixture, 'utf8');
// runCli normally receives this build-time constant from tsup/vitest. The
// generator imports the source directly so it supplies the same package value.
Reflect.set(globalThis, '__PKG_VERSION__', '0.0.0');
const { runCli } = await import('../src/cli/index');

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function terminalSvg(text: string): string {
  const lines = text.split('\n');
  const width = 1100;
  const lineHeight = 22;
  const height = 72 + lines.length * lineHeight;
  const rows = lines
    .map(
      (line, index) =>
        `  <text x="28" y="${52 + index * lineHeight}" class="terminal-line">${xml(line) || ' '}</text>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">ScriptSpect pre-release demo output</title>
  <desc id="desc">Terminal output from checking the README demo fixture. The selectable text version is available beside this image.</desc>
  <style>.terminal { fill: #0d1117; } .bar { fill: #161b22; } .terminal-line { fill: #c9d1d9; font: 16px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }</style>
  <rect class="terminal" width="100%" height="100%" rx="12"/>
  <rect class="bar" width="100%" height="34" rx="12"/>
  <circle cx="22" cy="17" r="5" fill="#ff7b72"/><circle cx="40" cy="17" r="5" fill="#d29922"/><circle cx="58" cy="17" r="5" fill="#3fb950"/>
${rows}
</svg>
`;
}

mkdirSync(outputDir, { recursive: true });
const dir = mkdtempSync(resolve(tmpdir(), 'scriptspect-readme-demo-'));
try {
  writeFileSync(resolve(dir, 'package.json'), before);
  const findings: string[] = [];
  const findingExitCode = await runCli([dir, '--no-color'], {
    out: (line) => findings.push(line),
    err: (line) => findings.push(line),
  });
  if (findingExitCode !== 1)
    throw new Error(`README demo expected exit code 1, got ${findingExitCode}`);

  const patch: string[] = [];
  const patchExitCode = await runCli([dir, '--fix-dry-run', '--no-color'], {
    out: (line) => patch.push(line),
    err: (line) => patch.push(line),
  });
  if (patchExitCode !== 1)
    throw new Error(`README demo dry-run expected exit code 1, got ${patchExitCode}`);

  const fixed: string[] = [];
  const fixedExitCode = await runCli([dir, '--fix', '--no-color'], {
    out: (line) => fixed.push(line),
    err: (line) => fixed.push(line),
  });
  if (fixedExitCode !== 0)
    throw new Error(`README demo fixed run expected exit code 0, got ${fixedExitCode}`);

  const terminal = [
    `$ node dist/cli.mjs .`,
    stripAnsi(findings.join('\n')),
    `exit code: ${findingExitCode}`,
  ].join('\n');
  writeFileSync(resolve(outputDir, 'package.before.json'), before);
  writeFileSync(resolve(outputDir, 'terminal.txt'), `${terminal}\n`);
  writeFileSync(resolve(outputDir, 'fix.patch'), `${patch.slice(0, -1).join('\n').trim()}\n`);
  writeFileSync(
    resolve(outputDir, 'package.after.json'),
    readFileSync(resolve(dir, 'package.json'), 'utf8'),
  );
  writeFileSync(resolve(outputDir, 'terminal.svg'), terminalSvg(terminal));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('README demo artifacts generated');
