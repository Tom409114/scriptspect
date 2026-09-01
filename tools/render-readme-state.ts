import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReadmeReleaseReceipt,
  validateReceiptAgainstStatus,
} from './readme-release-receipt';
import { canonicalJsonDigest } from './release/release-state.mjs';

type ReleaseState = 'pre-release' | 'published';
type Locale = 'english' | 'chinese';

interface ReadmeStatus {
  schemaVersion: number;
  releaseState: ReleaseState;
  packageName: string;
  packageVersion: string;
  sourceCommit: string;
  nodeMajor: number;
  repository: string;
  releaseEvidence?: {
    receiptPath: string;
    digest: string;
  };
}

interface Options {
  status: string;
  english: string;
  chinese: string;
  check: boolean;
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaults: Options = {
  status: resolve(root, 'docs/readme-status.json'),
  english: resolve(root, 'README.md'),
  chinese: resolve(root, 'README.zh-CN.md'),
  check: false,
};

function fail(message: string): never {
  throw new Error(`README state: ${message}`);
}

function parseOptions(args: string[]): Options {
  const options = { ...defaults };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument !== '--status' && argument !== '--english' && argument !== '--chinese') {
      fail(`unknown option ${argument ?? ''}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.trim() === '') fail(`${argument} needs a path`);
    if (argument === '--status') options.status = resolve(value);
    if (argument === '--english') options.english = resolve(value);
    if (argument === '--chinese') options.chinese = resolve(value);
    index += 1;
  }
  return options;
}

function parseStatus(path: string): ReadmeStatus {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReadmeStatus>;
  if (value.schemaVersion !== 1) fail('unsupported status schema');
  if (value.releaseState !== 'pre-release' && value.releaseState !== 'published') {
    fail('releaseState must be pre-release or published');
  }
  if (value.packageName !== 'scriptspect') fail('unexpected package name');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.packageVersion ?? '')) {
    fail('package version must be stable semver');
  }
  if (!/^[0-9a-f]{40}$/u.test(value.sourceCommit ?? '')) {
    fail('source commit must be an exact lowercase SHA');
  }
  if (!Number.isInteger(value.nodeMajor) || (value.nodeMajor ?? 0) < 22) {
    fail('nodeMajor must be at least 22');
  }
  if (value.repository !== 'https://github.com/Tom409114/scriptspect') {
    fail('unexpected repository');
  }
  if (value.releaseState === 'pre-release') {
    if (value.releaseEvidence !== undefined) {
      fail('pre-release state must not contain terminal release evidence');
    }
  } else {
    if (value.packageVersion === '0.0.0') fail('published state needs a real package version');
    if (value.releaseEvidence === undefined) {
      fail('published state needs terminal release evidence');
    }
    const statusDirectory = dirname(resolve(path));
    const evidenceDirectory = resolve(statusDirectory, 'validation', 'releases');
    if (
      value.releaseEvidence.receiptPath.trim() === '' ||
      isAbsolute(value.releaseEvidence.receiptPath)
    ) {
      fail('terminal release evidence receiptPath must be a relative path');
    }
    const receiptPath = resolve(statusDirectory, value.releaseEvidence.receiptPath);
    const receiptRelativeToEvidence = relative(evidenceDirectory, receiptPath);
    if (
      receiptRelativeToEvidence === '' ||
      receiptRelativeToEvidence.startsWith('..') ||
      isAbsolute(receiptRelativeToEvidence)
    ) {
      fail('terminal release evidence receiptPath escapes docs/validation/releases');
    }
    try {
      const receipt = validateReadmeReleaseReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')));
      if (value.releaseEvidence.digest !== canonicalJsonDigest(receipt)) {
        fail('terminal release evidence receipt digest does not match');
      }
      validateReceiptAgainstStatus(receipt, value);
    } catch (error) {
      fail(
        `invalid terminal release evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return value as ReadmeStatus;
}

function marker(name: string, edge: 'start' | 'end'): string {
  return `<!-- readme-state:${name}:${edge} -->`;
}

function replaceBlock(markdown: string, name: string, body: string): string {
  const start = marker(name, 'start');
  const end = marker(name, 'end');
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    fail(`missing or invalid ${name} markers`);
  }
  if (markdown.indexOf(start, startIndex + start.length) >= 0)
    fail(`duplicate ${name} start marker`);
  if (markdown.indexOf(end, endIndex + end.length) >= 0) fail(`duplicate ${name} end marker`);
  return `${markdown.slice(0, startIndex)}${start}\n${body.trim()}\n${end}${markdown.slice(
    endIndex + end.length,
  )}`;
}

function releaseUrls(status: ReadmeStatus): { npm: string; release: string; tag: string } {
  const tag = `v${status.packageVersion}`;
  return {
    tag,
    npm: `https://www.npmjs.com/package/${status.packageName}/v/${status.packageVersion}`,
    release: `${status.repository}/releases/tag/${tag}`,
  };
}

function overview(status: ReadmeStatus, locale: Locale): string {
  if (status.releaseState === 'pre-release') {
    return locale === 'english'
      ? `> [!IMPORTANT]
> This repository is a **pre-release source evaluation**. The npm package and
> public Action tag do not exist yet; the copy-paste paths below deliberately
> use an immutable source commit.

**[See the real demo](#before-result-and-after)** · **[Evaluate from source](#evaluate-from-source-pre-release)** · **[GitHub Actions](#github-actions-preview-pre-release)** · **[Rules](docs/rules/README.md)**`
      : `> [!IMPORTANT]
> 本仓库目前是**预发布源码评估版**。npm package 与公开 Action tag 尚不存在；下面所有可复制步骤都特意固定到不可变 source commit。

**[查看真实 demo](#修复前分析结果与修复后)** · **[从源码评估](#从源码评估evaluate-from-source-pre-release)** · **[GitHub Actions](#github-actions-预览pre-release)** · **[规则列表](docs/rules/README.md)**`;
  }
  const urls = releaseUrls(status);
  return locale === 'english'
    ? `> [!TIP]
> Verified release: [\`${status.packageName}@${status.packageVersion}\`](${urls.npm}). The immutable Action
> tag is [\`${urls.tag}\`](${urls.release}); security-sensitive workflows can pin
> the full release commit \`${status.sourceCommit}\`.

**[Run in 30 seconds](#quick-start)** · **[See the real demo](#before-result-and-after)** · **[GitHub Actions](#github-actions)** · **[Rules](docs/rules/README.md)**`
    : `> [!TIP]
> 已验证 release：[\`${status.packageName}@${status.packageVersion}\`](${urls.npm})。不可变 Action tag 是
> [\`${urls.tag}\`](${urls.release})；安全敏感的 workflow 可以固定到完整 release commit
> \`${status.sourceCommit}\`。

**[30 秒开始](#快速开始quick-start)** · **[查看真实 demo](#修复前分析结果与修复后)** · **[GitHub Actions](#github-actions)** · **[规则列表](docs/rules/README.md)**`;
}

function evaluate(status: ReadmeStatus, locale: Locale): string {
  if (status.releaseState === 'pre-release') {
    return locale === 'english'
      ? `<!-- readme-section: evaluate -->
## Evaluate from source (pre-release)

Requires Node.js ${status.nodeMajor} or newer and pnpm via Corepack. Clone the repository, check
out the reviewed commit, install exactly from the lockfile, build, and scan the
versioned demo fixture. Findings exit \`1\`; a clean scan exits \`0\`; invalid input,
configuration, or I/O exits \`2\`.

\`\`\`bash
git clone ${status.repository}.git
cd scriptspect
git checkout ${status.sourceCommit}
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.mjs tests/fixtures/readme-demo
\`\`\`

There is deliberately no \`npx scriptspect\` quick start yet. The machine-readable
release state is [docs/readme-status.json](docs/readme-status.json).`
      : `<!-- readme-section: evaluate -->
## 从源码评估（Evaluate from source (pre-release)）

需要 Node.js ${status.nodeMajor} 或更高版本，并通过 Corepack 使用 pnpm。克隆仓库、检出经审阅的 commit、严格按 lockfile 安装、构建，再扫描版本化 demo fixture。存在 finding 时退出 \`1\`；clean scan 退出 \`0\`；无效输入、配置或 I/O 退出 \`2\`。

\`\`\`bash
git clone ${status.repository}.git
cd scriptspect
git checkout ${status.sourceCommit}
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.mjs tests/fixtures/readme-demo
\`\`\`

这里特意还没有 \`npx scriptspect\` 快速开始。机器可读的 release state 见 [docs/readme-status.json](docs/readme-status.json)。`;
  }
  const urls = releaseUrls(status);
  return locale === 'english'
    ? `<!-- readme-section: evaluate -->
## Quick start

Requires Node.js ${status.nodeMajor} or newer. Run the exact [verified npm release](${urls.npm})
without a global install:

\`\`\`bash
npx --yes ${status.packageName}@${status.packageVersion} .
\`\`\`

With pnpm:

\`\`\`bash
pnpm dlx ${status.packageName}@${status.packageVersion} .
\`\`\`

Findings exit \`1\`; a clean scan exits \`0\`; invalid input, configuration, or I/O
exits \`2\`. Start with \`--fix-dry-run\` before applying any reviewed fix.`
    : `<!-- readme-section: evaluate -->
## 快速开始（Quick start）

需要 Node.js ${status.nodeMajor} 或更高版本。无需全局安装，直接运行准确的[已验证 npm release](${urls.npm})：

\`\`\`bash
npx --yes ${status.packageName}@${status.packageVersion} .
\`\`\`

使用 pnpm：

\`\`\`bash
pnpm dlx ${status.packageName}@${status.packageVersion} .
\`\`\`

存在 finding 时退出 \`1\`；clean scan 退出 \`0\`；无效输入、配置或 I/O 退出 \`2\`。应用任何经审查的修复前，请先使用 \`--fix-dry-run\`。`;
}

function action(status: ReadmeStatus, locale: Locale): string {
  const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
  if (status.releaseState === 'pre-release') {
    const workflow = `\`\`\`yaml
name: scriptspect pre-release evaluation
on: [pull_request]
permissions:
  contents: read
jobs:
  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: ${checkout} # v7.0.1
        with:
          persist-credentials: false
      - uses: ${checkout} # v7.0.1
        with:
          repository: Tom409114/scriptspect
          ref: ${status.sourceCommit}
          path: .scriptspect
          persist-credentials: false
      - uses: ./.scriptspect
        with:
          path: .
\`\`\``;
    return locale === 'english'
      ? `<!-- readme-section: action -->
## GitHub Actions preview (pre-release)

This complete example checks out both the consumer and an immutable ScriptSpect
source commit, then runs the bundled local Action. Do not replace the commit
with the nonexistent \`Tom409114/scriptspect@v0.1\` tag. After a verified release,
security-sensitive workflows should continue pinning a full commit SHA.

${workflow}

The Action writes annotations, a job summary, and numeric outputs named
\`exit-code\`, \`packages\`, \`scripts\`, \`errors\`, \`warnings\`, and \`advisories\` before
marking a finding run as failed. Its default mode is read-only.`
      : `<!-- readme-section: action -->
## GitHub Actions 预览（pre-release）

这个完整示例会同时检出 consumer 与不可变 ScriptSpect source commit，然后运行 bundled local Action。不要把 commit 替换为尚不存在的 \`Tom409114/scriptspect@v0.1\` tag。正式 release 得到验证后，安全敏感 workflow 仍应固定到完整 commit SHA。

${workflow}

Action 会先写入 annotations、job summary 以及名为 \`exit-code\`、\`packages\`、\`scripts\`、\`errors\`、\`warnings\`、\`advisories\` 的数字 outputs，再把 finding run 标记为失败。默认模式只读。`;
  }
  const urls = releaseUrls(status);
  const workflow = `\`\`\`yaml
name: scriptspect
on: [pull_request]
permissions:
  contents: read
jobs:
  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: ${checkout} # v7.0.1
        with:
          persist-credentials: false
      - uses: Tom409114/scriptspect@${urls.tag}
        with:
          path: .
\`\`\``;
  return locale === 'english'
    ? `<!-- readme-section: action -->
## GitHub Actions

Use the [verified immutable release tag](${urls.release}) for readable workflows.
For the strongest supply-chain pin, replace \`${urls.tag}\` with the full release
commit \`${status.sourceCommit}\`.

${workflow}

The Action writes annotations, a job summary, and numeric outputs named
\`exit-code\`, \`packages\`, \`scripts\`, \`errors\`, \`warnings\`, and \`advisories\` before
marking a finding run as failed. Its default mode is read-only.`
    : `<!-- readme-section: action -->
## GitHub Actions

使用[已验证的不可变 release tag](${urls.release})可以保持 workflow 易读。若要获得最严格的供应链固定，请把 \`${urls.tag}\` 替换为完整 release commit \`${status.sourceCommit}\`。

${workflow}

Action 会先写入 annotations、job summary 以及名为 \`exit-code\`、\`packages\`、\`scripts\`、\`errors\`、\`warnings\`、\`advisories\` 的数字 outputs，再把 finding run 标记为失败。默认模式只读。`;
}

function releaseRow(status: ReadmeStatus, locale: Locale): string {
  if (status.releaseState === 'pre-release') {
    return locale === 'english'
      ? '**Release:** pre-release; no npm package or public Action reference yet.'
      : '**Release:** pre-release；目前没有 npm package 或公开 Action reference。';
  }
  const urls = releaseUrls(status);
  return locale === 'english'
    ? `**Release:** [npm ${status.packageVersion}](${urls.npm}) · [Action ${urls.tag}](${urls.release}) · full SHA \`${status.sourceCommit}\`.`
    : `**Release:** [npm ${status.packageVersion}](${urls.npm}) · [Action ${urls.tag}](${urls.release}) · 完整 SHA \`${status.sourceCommit}\`。`;
}

function scopeTable(status: ReadmeStatus, locale: Locale): string {
  const header =
    locale === 'english'
      ? status.releaseState === 'pre-release'
        ? 'Current source-evaluation behavior'
        : 'Current behavior'
      : status.releaseState === 'pre-release'
        ? '当前源码评估行为'
        : '当前行为';
  return locale === 'english'
    ? `| Area | ${header} |
| --- | --- |
| Projects | root \`package.json\` plus npm/Yarn/Bun workspaces and \`pnpm-workspace.yaml\` |
| Targets | \`posix-sh\` + \`cmd\` by default; opt-in \`powershell\` evidence |
| Findings | error, warning, and advisory with high/medium confidence |
| Output | stylish terminal text, versioned JSON, GitHub annotations + summary |
| Fixes | dry-run plus provable safe/conditional rewrites; ambiguous cases stay manual |
| Privacy | offline analysis; scripts are not executed; no telemetry |`
    : `| 范围 | ${header} |
| --- | --- |
| Projects | 根 \`package.json\`，以及 npm/Yarn/Bun workspaces 与 \`pnpm-workspace.yaml\` |
| Targets | 默认 \`posix-sh\` + \`cmd\`；可选 \`powershell\` evidence |
| Findings | error、warning、advisory，并带 high/medium confidence |
| Output | stylish terminal text、versioned JSON、GitHub annotations + summary |
| Fixes | dry-run 以及可证明的 safe/conditional rewrites；ambiguous case 保持 manual |
| Privacy | 离线分析；不执行 scripts；无 telemetry |`;
}

function productionFaq(status: ReadmeStatus, locale: Locale): string {
  if (status.releaseState === 'pre-release') {
    return locale === 'english'
      ? `**Can I use it in production CI today?** Treat this source checkout as an
evaluation build. Wait for public npm, Release, provenance, checksum, and
immutable Action-consumer evidence before depending on a released reference.`
      : '**现在能在 production CI 使用吗？** 请把这份 source checkout 当作 evaluation build。等待公开 npm、Release、provenance、checksum 与 immutable Action-consumer evidence 齐全后，再依赖 released reference。';
  }
  const urls = releaseUrls(status);
  return locale === 'english'
    ? `**Can I use it in production CI today?** Yes—use the verified \`${status.packageName}@${status.packageVersion}\`
package or immutable \`${urls.tag}\` Action reference above. Pin \`${status.sourceCommit}\`
when your policy requires an exact commit.`
    : `**现在能在 production CI 使用吗？** 可以——请使用上方已验证的 \`${status.packageName}@${status.packageVersion}\` package 或不可变 \`${urls.tag}\` Action reference。若策略要求精确 commit，请固定到 \`${status.sourceCommit}\`。`;
}

function render(markdown: string, status: ReadmeStatus, locale: Locale): string {
  let result = markdown;
  result = replaceBlock(result, 'overview', overview(status, locale));
  result = replaceBlock(result, 'evaluate', evaluate(status, locale));
  result = replaceBlock(result, 'action', action(status, locale));
  result = replaceBlock(result, 'scope-table', scopeTable(status, locale));
  result = replaceBlock(result, 'release-row', releaseRow(status, locale));
  result = replaceBlock(result, 'production-faq', productionFaq(status, locale));
  return result;
}

const options = parseOptions(process.argv.slice(2));
const status = parseStatus(options.status);
const homepages = (
  [
    ['english', options.english],
    ['chinese', options.chinese],
  ] as const
).map(([locale, path]) => {
  const current = readFileSync(path, 'utf8');
  const rendered = render(current, status, locale);
  if (options.check) {
    if (rendered !== current) fail(`${locale} homepage is stale for ${status.releaseState}`);
  }
  return { path, rendered };
});
if (!options.check) {
  for (const homepage of homepages) writeFileSync(homepage.path, homepage.rendered);
}

console.log(`README state ${options.check ? 'verified' : 'rendered'} (${status.releaseState})`);
