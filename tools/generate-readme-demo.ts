import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = resolve(root, 'tests/fixtures/readme-demo/package.json');
const actionEvidenceFile = resolve(root, 'docs/validation/readme-action-evidence.json');
const outputDir = resolve(root, 'docs/assets/demo');
const before = readFileSync(fixture, 'utf8');
type ActionEvidence = {
  sourceCommit: string;
  workflowRun: { id: number; name: string; url: string; conclusion: string };
  checkRun: {
    id: number;
    name: string;
    url: string;
    annotationCount: number;
    summarySha256: string;
  };
  cleanConsumer: {
    exitCode: number;
    packages: number;
    scripts: number;
    errors: number;
    warnings: number;
    advisories: number;
  };
  annotations: Array<{
    level: string;
    path: string;
    line: number;
    title: string;
    displayTitle?: string;
    message: string;
  }>;
};
const actionEvidence = JSON.parse(readFileSync(actionEvidenceFile, 'utf8')) as ActionEvidence;
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

const terminalMaxColumns = 104;

function wrapTerminalLine(line: string, maxColumns = terminalMaxColumns): string[] {
  if (line.length <= maxColumns) return [line];

  const initialIndent = line.match(/^\s*/u)?.[0] ?? '';
  const findingPrefix = line.match(/^PS\d{3}\s+\S+\s+\S+\s+/u)?.[0] ?? '';
  const continuationIndent = findingPrefix
    ? ' '.repeat(findingPrefix.length)
    : `${initialIndent}    `;
  const wrapped: string[] = [];
  let remaining = line;
  let first = true;

  while (remaining.length > 0) {
    const prefix = first ? '' : continuationIndent;
    const available = maxColumns - prefix.length;
    if (remaining.length <= available) {
      wrapped.push(`${prefix}${remaining}`);
      break;
    }

    const candidate = remaining.slice(0, available + 1);
    const whitespace = candidate.lastIndexOf(' ');
    const breakAt = whitespace > 0 ? whitespace : available;
    wrapped.push(`${prefix}${remaining.slice(0, breakAt).trimEnd()}`);
    remaining = remaining.slice(breakAt).trimStart();
    first = false;
  }

  return wrapped;
}

function terminalRowClass(line: string): string {
  if (line.startsWith('$ ')) return 'terminal-command';
  if (/^PS\d{3}\s+error\b/u.test(line)) return 'terminal-error';
  if (/^PS\d{3}\s+advisory\b/u.test(line)) return 'terminal-advisory';
  if (line.startsWith('package.json')) return 'terminal-section';
  if (line.startsWith('Scanned ') || line.startsWith('exit code:')) return 'terminal-summary';
  return '';
}

function terminalSvg(text: string): string {
  const lines = text.split('\n').flatMap((line) => {
    const className = terminalRowClass(line);
    return wrapTerminalLine(line).map((wrapped) => ({ text: wrapped, className }));
  });
  const width = 1100;
  const lineHeight = 22;
  const height = 72 + lines.length * lineHeight;
  const rows = lines
    .map(
      (line, index) =>
        `  <text x="28" y="${52 + index * lineHeight}" class="terminal-line${line.className ? ` ${line.className}` : ''}" data-columns="${line.text.length}">${xml(line.text) || ' '}</text>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">ScriptSpect demo output</title>
  <desc id="desc">Terminal output from checking the README demo fixture. The selectable text version is available beside this image.</desc>
  <style>.terminal { fill: #0d1117; } .bar { fill: #161b22; } .terminal-line { fill: #c9d1d9; font: 16px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; } .terminal-command { fill: #7ee787; } .terminal-section { fill: #79c0ff; font-weight: 600; } .terminal-error { fill: #ff7b72; font-weight: 600; } .terminal-advisory { fill: #d29922; font-weight: 600; } .terminal-summary { fill: #8b949e; }</style>
  <rect class="terminal" width="100%" height="100%" rx="12"/>
  <rect class="bar" width="100%" height="34" rx="12"/>
  <circle cx="22" cy="17" r="5" fill="#ff7b72"/><circle cx="40" cy="17" r="5" fill="#d29922"/><circle cx="58" cy="17" r="5" fill="#3fb950"/>
${rows}
</svg>
`;
}

function actionEvidenceText(evidence: ActionEvidence): string {
  const annotations = evidence.annotations.map(
    (annotation) =>
      `- ${annotation.title || annotation.displayTitle || 'Action annotation'} — ${annotation.path}: ${annotation.message.replaceAll('%3A', ':')}`,
  );
  return [
    'ScriptSpect hosted Action evidence',
    `workflow run: ${evidence.workflowRun.id} (${evidence.workflowRun.conclusion})`,
    `workflow URL: ${evidence.workflowRun.url}`,
    `source commit: ${evidence.sourceCommit}`,
    `clean consumer: exit ${evidence.cleanConsumer.exitCode} · ${evidence.cleanConsumer.packages} package · ${evidence.cleanConsumer.scripts} script · ${evidence.cleanConsumer.errors} errors`,
    `broken fixture: ${evidence.checkRun.annotationCount} annotations`,
    ...annotations,
    `job summary SHA-256: ${evidence.checkRun.summarySha256}`,
  ].join('\n');
}

function actionEvidenceSvg(evidence: ActionEvidence): string {
  const shortSha = evidence.sourceCommit.slice(0, 8);
  const finding =
    evidence.annotations.find((annotation) => /^PS\d{3}:/u.test(annotation.title)) ??
    evidence.annotations[0];
  if (finding === undefined) throw new Error('README Action evidence needs an annotation');
  const findingMessage = finding.message.replaceAll('%3A', ':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="480" viewBox="0 0 1100 480" role="img" aria-labelledby="title desc" data-run-id="${evidence.workflowRun.id}">
  <title id="title">Hosted Action evidence</title>
  <desc id="desc">Public CI run ${evidence.workflowRun.id} passed at source commit ${shortSha}. A clean consumer returned zero errors, while the broken fixture produced ${evidence.checkRun.annotationCount} annotations including ${xml(finding.title)}.</desc>
  <defs>
    <linearGradient id="action-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#090d1a"/>
      <stop offset="0.55" stop-color="#111a35"/>
      <stop offset="1" stop-color="#09251f"/>
    </linearGradient>
    <linearGradient id="action-line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="0.52" stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <style>
    .sans { font-family: Inter,Segoe UI,Arial,sans-serif; }
    .mono { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; }
    .muted { fill: #91a4c4; }
    .label { fill: #b8c7df; font-size: 15px; font-weight: 650; letter-spacing: .7px; }
    .metric { fill: #f5f8ff; font-size: 28px; font-weight: 760; }
  </style>
  <rect width="1100" height="480" rx="22" fill="url(#action-bg)"/>
  <rect x="1" y="1" width="1098" height="478" rx="21" fill="none" stroke="#7c8db5" stroke-opacity="0.28"/>
  <rect x="52" y="46" width="9" height="42" rx="4.5" fill="url(#action-line)"/>
  <text x="82" y="70" class="sans" fill="#f8fbff" font-size="30" font-weight="770">Hosted Action evidence</text>
  <text x="82" y="94" class="mono muted" font-size="14">main @ ${shortSha} · CI run #${evidence.workflowRun.id}</text>
  <rect x="866" y="50" width="182" height="38" rx="19" fill="#10372f" stroke="#34d399" stroke-opacity="0.65"/>
  <circle cx="890" cy="69" r="7" fill="#34d399"/>
  <text x="908" y="75" class="sans" fill="#a7f3d0" font-size="16" font-weight="720">VERIFIED · PASS</text>

  <g transform="translate(52 132)">
    <rect width="306" height="150" rx="16" fill="#10182d" stroke="#6475a3" stroke-opacity="0.35"/>
    <text x="24" y="34" class="sans label">CLEAN CONSUMER</text>
    <text x="24" y="82" class="sans metric">${evidence.cleanConsumer.errors} errors</text>
    <text x="24" y="112" class="mono muted" font-size="15">${evidence.cleanConsumer.packages} package · ${evidence.cleanConsumer.scripts} script</text>
    <path d="M25 130l7 7 13-16" fill="none" stroke="#34d399" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="56" y="139" class="sans" fill="#a7f3d0" font-size="15">exit code ${evidence.cleanConsumer.exitCode}</text>
  </g>

  <g transform="translate(397 132)">
    <rect width="306" height="150" rx="16" fill="#10182d" stroke="#6475a3" stroke-opacity="0.35"/>
    <text x="24" y="34" class="sans label">BROKEN FIXTURE</text>
    <text x="24" y="82" class="sans metric">${evidence.checkRun.annotationCount} annotations</text>
    <text x="24" y="112" class="mono" fill="#ffb4ad" font-size="16" font-weight="700">${xml(finding.title)}</text>
    <text x="24" y="136" class="mono muted" font-size="14">${xml(finding.path)} · target cmd</text>
  </g>

  <g transform="translate(742 132)">
    <rect width="306" height="150" rx="16" fill="#10182d" stroke="#6475a3" stroke-opacity="0.35"/>
    <text x="24" y="34" class="sans label">ACTION CONTRACT</text>
    <text x="24" y="75" class="sans" fill="#f5f8ff" font-size="20" font-weight="720">Annotations + summary</text>
    <text x="24" y="105" class="sans" fill="#f5f8ff" font-size="20" font-weight="720">Numeric outputs</text>
    <text x="24" y="134" class="mono muted" font-size="14">read-only by default</text>
  </g>

  <g transform="translate(52 322)">
    <rect width="996" height="104" rx="14" fill="#0b1223" stroke="#ef6f6c" stroke-opacity="0.34"/>
    <rect width="7" height="104" rx="3.5" fill="#ff7b72"/>
    <text x="28" y="30" class="mono" fill="#ffb4ad" font-size="15" font-weight="720">${xml(finding.title)}</text>
    <text x="28" y="58" class="mono" fill="#d7e2f4" font-size="15">${xml(findingMessage)}</text>
    <text x="28" y="84" class="sans muted" font-size="14">Generated from committed public run evidence · package scripts were never executed</text>
  </g>
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
  const hostedAction = actionEvidenceText(actionEvidence);
  writeFileSync(resolve(outputDir, 'action.txt'), `${hostedAction}\n`);
  writeFileSync(resolve(outputDir, 'action.svg'), actionEvidenceSvg(actionEvidence));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('README demo artifacts generated');
