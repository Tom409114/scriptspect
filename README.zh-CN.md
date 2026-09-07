[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <picture>
    <source media="(max-width: 700px)" srcset="docs/assets/brand/hero-mobile.svg">
    <img src="docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect 在脚本运行前检查 POSIX shell、Windows cmd 与 PowerShell 的可移植性问题">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/Tom409114/scriptspect/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Tom409114/scriptspect/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-6f7bf7.svg"></a>
</p>

<p align="center"><strong>在 CI 或用户踩坑之前，先让 package.json scripts 在 macOS、Linux 与 Windows 上真正可用。</strong></p>

ScriptSpect 是 npm 风格 `package.json` scripts 的跨平台预检工具。把一个
Node.js 项目或 monorepo 交给它，它不会执行 scripts，而是直接指出哪一段
命令会在 `posix-sh`、Windows `cmd` 或可选 `powershell` 下出错、影响哪个
平台、为什么出错，并且只在安全条件得到证明时提供修复。

<!-- readme-state:overview:start -->
> [!TIP]
> 已验证 release：[`scriptspect@0.1.2`](https://www.npmjs.com/package/scriptspect/v/0.1.2)。不可变 Action tag 是
> [`v0.1.2`](https://github.com/Tom409114/scriptspect/releases/tag/v0.1.2)；安全敏感的 workflow 可以固定到完整 release commit
> `6f439bb974b297d5a334cebe989b4b50d7483677`。

**[30 秒开始](#快速开始quick-start)** · **[查看真实 demo](#修复前分析结果与修复后)** · **[GitHub Actions](#github-actions)** · **[规则列表](docs/rules/README.md)**
<!-- readme-state:overview:end -->

<!-- readme-state:evaluate:start -->
<!-- readme-section: evaluate -->
## 快速开始（Quick start）

需要 Node.js 22 或更高版本。无需全局安装，直接运行准确的[已验证 npm release](https://www.npmjs.com/package/scriptspect/v/0.1.2)：

```bash
npx --yes scriptspect@0.1.2 .
```

使用 pnpm：

```bash
pnpm dlx scriptspect@0.1.2 .
```

存在 finding 时退出 `1`；clean scan 退出 `0`；无效输入、配置或 I/O 退出 `2`。应用任何经审查的修复前，请先使用 `--fix-dry-run`。
<!-- readme-state:evaluate:end -->

<!-- readme-section: purpose -->
## 同一个项目，不同的电脑，同样能用的脚本

**你在 Mac 上构建成功，贡献者换到 Windows 却报错。**
ScriptSpect 提前找出 `package.json` 中依赖特定 shell 的写法，把问题挡在 CI 之前。

| 你的工作场景 | ScriptSpect 帮你做什么 |
| --- | --- |
| 维护 JS/TS 应用、库或 CLI | 指出哪条命令、在哪个平台有可移植性问题。 |
| 管理 monorepo | 一起检查根项目和自动发现的 workspaces。 |
| 审查开发者或 agent 生成的脚本 | 获取结构化 JSON 或 PR 标注，再用 `--fix-dry-run` 预览修改。 |

**选一个仓库 → 查看问题 → 审查补丁。**
分析在本地完成，默认只读；是否应用修复，由你决定。

<!-- readme-section: why -->
## 为什么值得使用

| 提前发现跨平台故障 | 解释具体 target | 让修复可审查 |
| --- | --- | --- |
| 在另一种操作系统真正执行前，找出依赖特定 shell 的命令、operator、expansion、redirection、path 与未声明 executable。 | 每条 finding 都带有稳定 rule ID、package/script path、source span、severity、confidence 与受影响 targets。 | `safe`、`conditional`、`manual` 三类安全级别，避免在无法证明等价时进行“热心”改写。 |

ScriptSpect 使用 target-specific 的结构化 parser，而不是用一组正则表达式扫描 quoted text。它有意不做完整 shell interpreter；finding 仍应由拥有该 script 的项目审查。

[`scripts-doctor`](docs/comparison.md) 是相邻的 analyzer 基线。`cross-env`、
`shx` 与 `rimraf` 是 ScriptSpect 在满足前置条件时可能推荐的修复手段，
不是静态分析竞品。

<!-- readme-section: demo -->
## 修复前、分析结果与修复后

这里的全部内容都由版本化 [demo fixture](tests/fixtures/readme-demo/package.json) 生成，因此 screenshot 与 patch 不会偏离可执行行为。

**修复前——两条假定 POSIX shell 的 scripts：**

```json
{
  "name": "portable-demo",
  "private": true,
  "scripts": {
    "build": "NODE_ENV=production vite build",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "cross-env": "^7.0.3",
    "rimraf": "^6.0.1",
    "vite": "^7.0.0"
  }
}
```

**分析结果——`PS001` 与 `PS010` 精确指出不兼容 cmd 的 span：**

![自动生成的终端记录，显示 ScriptSpect 的 PS001 与 PS010 findings](docs/assets/demo/terminal.svg)

[可选择的终端文本](docs/assets/demo/terminal.txt) · [完整生成 patch](docs/assets/demo/fix.patch) · [验证后的文件](docs/assets/demo/package.after.json)

**修复后——conditional rewrites 使用项目已经声明的 dependencies：**

```diff
-"build": "NODE_ENV=production vite build"
-"clean": "rm -rf dist"
+"build": "cross-env NODE_ENV=production vite build"
+"clean": "rimraf dist"
```

`--fix-dry-run` 只打印 patch 而不写入。`--fix` 使用 staged writes、写后重新分析与 recovery journal；它不会安装依赖或改写 lockfile。使用 `pnpm exec tsx tools/generate-readme-demo.ts` 可重新生成全部 demo assets。

<!-- readme-section: cli -->
## CLI 快速参考

CLI 支持终端输出、JSON、GitHub annotations、指定规则、选择目标 shell 与按需修复。

```bash
npx --yes scriptspect@0.1.2 .
npx --yes scriptspect@0.1.2 . --format json
npx --yes scriptspect@0.1.2 . --target posix-sh,cmd,powershell
npx --yes scriptspect@0.1.2 . --rule PS001,PS010
npx --yes scriptspect@0.1.2 . --fix-dry-run
npx --yes scriptspect@0.1.2 . --fix
npx --yes scriptspect@0.1.2 explain PS010
```

显示过滤不会隐藏失败语义：任何配置为 `error` 的 finding 都会失败；未过滤 warning 总数会与 `--max-warnings` 比较。

<!-- readme-state:action:start -->
<!-- readme-section: action -->
## GitHub Actions

使用[已验证的不可变 release tag](https://github.com/Tom409114/scriptspect/releases/tag/v0.1.2)可以保持 workflow 易读。若要获得最严格的供应链固定，请把 `v0.1.2` 替换为完整 release commit `6f439bb974b297d5a334cebe989b4b50d7483677`。

```yaml
name: scriptspect
on: [pull_request]
permissions:
  contents: read
jobs:
  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: Tom409114/scriptspect@v0.1.2
        with:
          path: .
```

Action 会先写入 annotations、job summary 以及名为 `exit-code`、`packages`、`scripts`、`errors`、`warnings`、`advisories` 的数字 outputs，再把 finding run 标记为失败。默认模式只读。
<!-- readme-state:action:end -->

**真实托管证据——不是模拟截图。** 在 `main` 的 `c9c671c8` 上，公开的 [CI run #33482453059](https://github.com/Tom409114/scriptspect/actions/runs/33482453059) 使用 `uses: ./` 分别消费 clean 与 broken fixture。clean consumer 返回 `1 package · 1 script · 0 errors`；broken fixture 产生 2 条 check annotations，其中包括落在 `package.json` 上的 `PS010: scripts.clean`。

![根据真实托管 Action run 生成的验证卡片](docs/assets/demo/action.svg)

[可选择的 Action 证据文本](docs/assets/demo/action.txt) · [提交进仓库的源证据](docs/validation/readme-action-evidence.json) · [打开托管 job](https://github.com/Tom409114/scriptspect/actions/runs/33482453059/job/99774890433)

<!-- readme-section: config -->
## 最小配置

默认 targets 为 `posix-sh` 与 `cmd`。可以把同一份小型 contract 放在根 `package.json` 的 `scriptspect` 字段，或放入 `scriptspect.config.json`：

```json
{
  "targets": ["posix-sh", "cmd"],
  "severity": { "PS015": "advisory" },
  "ignore": [
    { "packages": ["examples/**"], "rules": ["PS030"] },
    { "scripts": ["docs:unix"], "rules": ["PS010", "PS011"] }
  ]
}
```

优先级确定且采用整体替换：`--config` → `package.json#scriptspect` → `scriptspect.config.json` → defaults。之后，`--target` 只替换已选配置中的 target list。不同 config source 绝不会 merge。Ignore entry 必须指定 rules，并应足够精确地解释有意的平台专用 script。

Contracts：[config JSON Schema](schema/config.schema.json) · [JSON output Schema](schema/output.schema.json)

<!-- readme-section: support -->
## 支持的工作流

<!-- readme-state:scope-table:start -->
| 范围 | 当前行为 |
| --- | --- |
| Projects | 根 `package.json`，以及 npm/Yarn/Bun workspaces 与 `pnpm-workspace.yaml` |
| Targets | 默认 `posix-sh` + `cmd`；可选 `powershell` evidence |
| Findings | error、warning、advisory，并带 high/medium confidence |
| Output | stylish terminal text、versioned JSON、GitHub annotations + summary |
| Fixes | dry-run 以及可证明的 safe/conditional rewrites；ambiguous case 保持 manual |
| Privacy | 离线分析；不执行 scripts；无 telemetry |
<!-- readme-state:scope-table:end -->
<!-- readme-state:release-row:start -->
**Release:** [npm 0.1.2](https://www.npmjs.com/package/scriptspect/v/0.1.2) · [Action v0.1.2](https://github.com/Tom409114/scriptspect/releases/tag/v0.1.2) · 完整 SHA `6f439bb974b297d5a334cebe989b4b50d7483677`。
<!-- readme-state:release-row:end -->

遇到真实的跨平台故障？[提交 issue](https://github.com/Tom409114/scriptspect/issues/new/choose)，附上脚本、目标 shell 和预期行为。你的例子能帮助改进规则。

<!-- readme-section: faq -->
## 常见问题与故障排查

**它会运行我的 scripts 吗？** 不会。它只读取 package manifests 并执行静态结构分析。

**为什么显示过滤掉 warning 后仍退出 `1`？** 失败会在 presentation filter 之前计算：配置为 error 的 finding 与完整 warning budget 仍然生效。使用 `--format json` 查看完整 contract。

**为什么没有 automatic fix？** Parser 必须在 active targets 间对 replacement 的结构角色达成一致，而且 conditional fix 要求精确 dependency 已声明；否则 finding 只解释问题并保持 manual。

**最终使用了哪个 config？** 显式 `--config` 优先，其次是 `package.json` 字段、standalone file，最后是 defaults。人类可读输出会报告非默认 source。

<!-- readme-state:production-faq:start -->
**现在能在 production CI 使用吗？** 可以——请使用上方已验证的 `scriptspect@0.1.2` package 或不可变 `v0.1.2` Action reference。若策略要求精确 commit，请固定到 `6f439bb974b297d5a334cebe989b4b50d7483677`。
<!-- readme-state:production-faq:end -->

<!-- readme-section: navigation -->
## 深入了解

以下均为 English documentation：

- [Documentation index](docs/README.md)
- [All rules](docs/rules/README.md)
- [Architecture and parser contract](docs/architecture.md)
- [Comparison boundary](docs/comparison.md)
- [Compliance audit](docs/validation/spec-compliance-2026-09-01.md)
- [Corpus methodology](docs/evidence/corpus-method.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [分享 ScriptSpect：首发文案与演示脚本](docs/launch-kit.md)
- [Roadmap](docs/roadmap.md)
- [Evidence policy](docs/evidence/README.md)

<!-- readme-section: license -->
## 许可证

[MIT](LICENSE)
