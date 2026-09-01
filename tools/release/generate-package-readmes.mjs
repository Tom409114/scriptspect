import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function fail(message) {
  throw new Error(`package README: ${message}`);
}

function parseArguments(arguments_) {
  const allowed = new Set(['--version', '--source-commit', '--channel', '--english', '--chinese']);
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name)) fail(`unknown option ${name ?? ''}`);
    if (value === undefined || value.startsWith('--')) fail(`${name} needs one value`);
    if (values.has(name)) fail(`${name} may be passed only once`);
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`${name} is required`);
  }
  return {
    version: values.get('--version'),
    sourceCommit: values.get('--source-commit'),
    channel: values.get('--channel'),
    english: resolve(values.get('--english')),
    chinese: resolve(values.get('--chinese')),
  };
}

function validate(options) {
  const semver =
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
  if (!semver.test(options.version)) fail('version must be exact SemVer without build metadata');
  if (!/^[0-9a-f]{40}$/u.test(options.sourceCommit)) {
    fail('source commit must be an exact lowercase 40-character SHA');
  }
  if (!['stable', 'bootstrap'].includes(options.channel)) fail('invalid channel');
  if (
    options.channel === 'stable' &&
    (options.version === '0.0.0' || options.version.includes('-'))
  ) {
    fail('stable channel needs a nonzero stable version');
  }
  if (
    options.channel === 'bootstrap' &&
    !/^0\.0\.0-bootstrap\.(?:0|[1-9][0-9]*)$/u.test(options.version)
  ) {
    fail('bootstrap channel needs version 0.0.0-bootstrap.N');
  }
  if (options.english === options.chinese) fail('output paths must differ');
}

function context(version, sourceCommit) {
  return {
    repository: 'https://github.com/Tom409114/scriptspect',
    raw: `https://raw.githubusercontent.com/Tom409114/scriptspect/${sourceCommit}`,
    unpkg: `https://unpkg.com/scriptspect@${version}`,
  };
}

function stableEnglish(version, sourceCommit) {
  const { repository, raw, unpkg } = context(version, sourceCommit);
  return `[English](${unpkg}/README.md) | [简体中文](${unpkg}/README.zh-CN.md)

<p align="center"><img src="${raw}/docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect finds cross-shell portability problems before package scripts run"></p>

> **Package edition:** \`scriptspect@${version}\` · source \`${sourceCommit}\`

ScriptSpect statically checks \`package.json\` scripts without running them. It pinpoints constructs that change meaning across POSIX shell, Windows cmd, and optional PowerShell targets.

## Run in 30 seconds

Requires Node.js 22 or newer. Run this exact version without a global install:

\`\`\`bash
npx --yes scriptspect@${version} .
pnpm dlx scriptspect@${version} .
\`\`\`

Findings exit \`1\`; a clean scan exits \`0\`; invalid input, configuration, or I/O exits \`2\`. Start with \`--fix-dry-run\` before applying a reviewed fix.

## Before, result, and after

\`\`\`json
{"scripts":{"build":"NODE_ENV=production vite build","clean":"rm -rf dist"}}
\`\`\`

![Real ScriptSpect output generated from the versioned demo fixture](${raw}/docs/assets/demo/terminal.svg)

\`\`\`diff
-"build": "NODE_ENV=production vite build"
-"clean": "rm -rf dist"
+"build": "cross-env NODE_ENV=production vite build"
+"clean": "rimraf dist"
\`\`\`

The demo uses dependencies already declared by the fixture. Ambiguous changes remain manual; ScriptSpect never installs dependencies or rewrites a lockfile.

## GitHub Actions

\`\`\`yaml
- uses: Tom409114/scriptspect@v${version}
  with:
    path: .
\`\`\`

For the strongest supply-chain pin, replace \`v${version}\` with \`${sourceCommit}\`.

[Rules](${repository}/tree/${sourceCommit}/docs/rules) · [Config schema](${repository}/blob/${sourceCommit}/schema/config.schema.json) · [Report a vulnerability](${repository}/security/advisories/new) · [Source](${repository}/tree/${sourceCommit})
`;
}

function stableChinese(version, sourceCommit) {
  const { repository, raw, unpkg } = context(version, sourceCommit);
  return `[English](${unpkg}/README.md) | [简体中文](${unpkg}/README.zh-CN.md)

<p align="center"><img src="${raw}/docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect 在 package scripts 运行前发现跨 shell 可移植性问题"></p>

> **Package 版本：** \`scriptspect@${version}\` · source \`${sourceCommit}\`

ScriptSpect 不运行 scripts，只对 \`package.json\` 做静态分析。它会精确指出在 POSIX shell、Windows cmd 与可选 PowerShell target 之间含义不同的结构。

## 30 秒开始

需要 Node.js 22 或更高版本。无需全局安装，直接运行这个准确版本：

\`\`\`bash
npx --yes scriptspect@${version} .
pnpm dlx scriptspect@${version} .
\`\`\`

存在 finding 时退出 \`1\`；clean scan 退出 \`0\`；无效输入、配置或 I/O 退出 \`2\`。应用经审查的修复前，请先使用 \`--fix-dry-run\`。

## 修复前、分析结果与修复后

\`\`\`json
{"scripts":{"build":"NODE_ENV=production vite build","clean":"rm -rf dist"}}
\`\`\`

![由版本化 demo fixture 生成的真实 ScriptSpect 输出](${raw}/docs/assets/demo/terminal.svg)

\`\`\`diff
-"build": "NODE_ENV=production vite build"
-"clean": "rm -rf dist"
+"build": "cross-env NODE_ENV=production vite build"
+"clean": "rimraf dist"
\`\`\`

这个 demo 只使用 fixture 已声明的 dependencies。歧义修改始终保持 manual；ScriptSpect 不会安装 dependencies，也不会改写 lockfile。

## GitHub Actions

\`\`\`yaml
- uses: Tom409114/scriptspect@v${version}
  with:
    path: .
\`\`\`

若要获得最严格的供应链固定，请把 \`v${version}\` 替换为 \`${sourceCommit}\`。

[规则列表](${repository}/tree/${sourceCommit}/docs/rules) · [配置 Schema](${repository}/blob/${sourceCommit}/schema/config.schema.json) · [报告漏洞](${repository}/security/advisories/new) · [源码](${repository}/tree/${sourceCommit})
`;
}

function bootstrapEnglish(version, sourceCommit) {
  const { repository, raw, unpkg } = context(version, sourceCommit);
  return `[English](${unpkg}/README.md) | [简体中文](${unpkg}/README.zh-CN.md)

<p align="center"><img src="${raw}/docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect package-script portability analyzer"></p>

# ScriptSpect npm bootstrap artifact

\`scriptspect@${version}\` is a one-time npm ownership and integrity bootstrap artifact. It is **not a supported stable release**, does not move the \`latest\` dist-tag, and must not be used as a stable GitHub Action reference.

The bootstrap workflow checks its retained candidate, registry bytes, package tree, CLI, schemas, and bundled Action against source commit \`${sourceCommit}\`.

[Project homepage](${repository}/tree/${sourceCommit}) · [Bootstrap workflow policy](${repository}/blob/${sourceCommit}/.github/workflows/npm-bootstrap.yml)
`;
}

function bootstrapChinese(version, sourceCommit) {
  const { repository, raw, unpkg } = context(version, sourceCommit);
  return `[English](${unpkg}/README.md) | [简体中文](${unpkg}/README.zh-CN.md)

<p align="center"><img src="${raw}/docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect package script 可移植性分析器"></p>

# ScriptSpect npm bootstrap artifact

\`scriptspect@${version}\` 是一次性的 npm ownership 与 integrity bootstrap artifact。它**不是受支持的 stable release**，不会移动 \`latest\` dist-tag，也不能作为稳定 GitHub Action reference 使用。

bootstrap workflow 会把 retained candidate、registry bytes、package tree、CLI、schemas 与 bundled Action 对照 source commit \`${sourceCommit}\` 进行检查。

[项目主页](${repository}/tree/${sourceCommit}) · [Bootstrap workflow policy](${repository}/blob/${sourceCommit}/.github/workflows/npm-bootstrap.yml)
`;
}

const options = parseArguments(process.argv.slice(2));
validate(options);
const english =
  options.channel === 'stable'
    ? stableEnglish(options.version, options.sourceCommit)
    : bootstrapEnglish(options.version, options.sourceCommit);
const chinese =
  options.channel === 'stable'
    ? stableChinese(options.version, options.sourceCommit)
    : bootstrapChinese(options.version, options.sourceCommit);
for (const [path, content] of [
  [options.english, english],
  [options.chinese, chinese],
]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
console.log(`package READMEs generated (${options.channel} ${options.version})`);
