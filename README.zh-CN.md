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

<p align="center"><strong>在 CI 报错、同事踩坑之前，提前发现 package.json 脚本的跨平台问题。</strong></p>

ScriptSpect 是 npm 风格 `package.json` scripts 的跨平台预检工具。把一个
Node.js 项目或 monorepo 交给它，它不会执行 scripts，而是直接指出哪一段
命令可能在 `posix-sh`、Windows `cmd` 或可选 `powershell` 下出错、影响哪个
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

**它的实际收益：在审查代码时就发现 shell 写法不兼容，不必等同事换台电脑、
或者另一个系统的 CI 报错后再排查。**
跨系统协作、对外发布开发工具、经常让编程 agent 修改项目脚本的仓库，尤其适合接入这一步检查。

<!-- readme-section: demo -->
## 修复前、分析结果与修复后

### 实例一 · “我的 Mac 能构建，为什么同事的 Windows 报错？”

你维护一个 Vite 项目，同事或编程 agent 加了下面两条命令。
Mac 上这是常见的 shell 写法；Windows 的原生 npm 脚本默认使用 `cmd`，
环境变量赋值写法和 `rm -rf` 在这里不兼容。

**亲手试一次：**新建一个空文件夹，把下面完整内容保存为 `package.json`，
在该文件夹打开终端。这次扫描和修改演示，无需安装或执行里面声明的构建工具。

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

**第一步：不运行构建，先找出问题。**

```bash
npx --yes scriptspect@0.1.2 .
```

| 哪条脚本 | 检查结果 | 对你意味着什么 |
| --- | --- | --- |
| `build` | `PS001` · `NODE_ENV=production` | Windows cmd 不使用这种环境变量赋值语法。 |
| `clean` | `PS010` · `rm -rf dist` | Windows 原生 cmd 没有这条命令。 |

实际扫描得到 **2 个错误、2 条提示**，退出码为 `1`。
提示进一步解释同一条构建命令在不同 shell 中的解析差异。
下面的截图与补丁来自可执行的 [演示样例](tests/fixtures/readme-demo/package.json)。

![自动生成的终端记录，显示 ScriptSpect 的 PS001 与 PS010 findings](docs/assets/demo/terminal.svg)

[可选择的终端文本](docs/assets/demo/terminal.txt) · [完整生成 patch](docs/assets/demo/fix.patch) · [验证后的文件](docs/assets/demo/package.after.json)

**第二步：先预览怎么改，不修改文件。**

```bash
npx --yes scriptspect@0.1.2 . --fix-dry-run
```

关键变化如下。这个样例已声明 `cross-env` 和 `rimraf`，所以可以提供这些改写：

```diff
-"build": "NODE_ENV=production vite build"
-"clean": "rm -rf dist"
+"build": "cross-env NODE_ENV=production vite build"
+"clean": "rimraf dist"
```

**第三步：确认修改，再应用并重新检查。**

```bash
npx --yes scriptspect@0.1.2 . --fix
npx --yes scriptspect@0.1.2 .
```

已发布版本的实际运行结果：

```text
scriptspect: fixed 2 script(s) in package.json
Scanned 2 scripts across 1 package · 0 errors · 0 warnings
```

最后一次扫描退出码为 `0`，没有发现问题。演示中的两处 shell 不兼容写法，
在任何人运行构建之前就被改掉了。在自己的项目中，请审查补丁，并自行管理依赖安装。

### 实例二 · 让编程 agent 拿到具体、可操作的检查结果

agent 修改 `package.json` 后，运行：

```bash
npx --yes scriptspect@0.1.2 . --format json
```

对上面的原始样例，一条检查结果包含这些字段（摘录）：

```json
{
  "ruleId": "PS001",
  "scriptName": "build",
  "packagePath": "package.json",
  "severity": "error",
  "affectedTargets": ["cmd"]
}
```

把 JSON 输出粘贴到编程 agent 的对话中，或者让 agent 通过终端工具运行这条命令。
让它针对结果中的文件、脚本和目标系统提出最小修改，再由你审查补丁并重新扫描。
同一条命令也能自动发现受支持的 monorepo workspaces，分别指出各个包里的问题。

### 实例三 · 在 PR 里自动拦住同类问题

接入[下面的 GitHub Actions 工作流](#github-actions)后，如果后续 PR 又加入了不兼容的清理命令，
检查会失败，并在 `package.json` 上留下标注；干净样例会通过。
工作流下方展示了真实的线上运行结果，审查代码时就能看到问题。

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
