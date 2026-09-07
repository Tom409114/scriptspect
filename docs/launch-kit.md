# ScriptSpect launch kit

Prepared 2026-09-08. Drafts only: no external posts or outreach have been sent.

## Message

**English:** Catch cross-platform bugs in package.json scripts before CI does.

**中文：** 别等 Windows CI 报错，先检查 package.json 脚本的跨平台问题。

Audience: JavaScript/TypeScript maintainers, monorepo teams, cross-platform contributors, and people reviewing coding-agent changes.

Promise: point to the problematic command, explain the affected shell, and preview a reviewable patch. Show the actual output. Do not promise universal compatibility, measured accuracy, external adoption, or a general-purpose agent integration layer.

## First launch: aim for useful feedback

Target: 5–10 developers trying one real repository, not a promised number of stars. Record actual results only.

1. Publish the stable README, working install command and demo first.
2. Post one Chinese introduction on V2EX 分享创造, following its current node rules.
3. Post the English introduction to Show HN with the GitHub URL and an immediate way to try it. Stay available for questions.
4. Write a technical walkthrough using the real fixture: why POSIX environment assignment and `rm` cause trouble in Windows cmd, how findings are produced, and when conditional fixes apply.
5. With permission, ask a few maintainers already working on cross-platform scripts for feedback. Do not open unsolicited promotional issues, mass-message users, buy stars, or coordinate votes.

Use small, separated launches so feedback from the first improves the next. Recheck community rules before posting:
[Show HN](https://news.ycombinator.com/showhn.html), [V2EX nodes](https://www.v2ex.com/help/node), [V2EX FAQ](https://www.v2ex.com/faq).

## English post — draft

**Title:** Show HN: ScriptSpect – check package.json scripts for cross-platform bugs

I built ScriptSpect to catch the “works on my Mac, fails on Windows” problems hidden in package.json scripts.

For example, `NODE_ENV=production vite build` and `rm -rf dist` assume a shell environment that isn't the default Windows cmd setup. ScriptSpect identifies the problematic spans, explains the affected targets, and can preview conditional replacements when the required tools are already declared.

It analyzes scripts without executing them. It supports workspace discovery, JSON output and a GitHub Action with PR annotations.

Try it in a Node.js project (Node.js 22+):

```bash
npx --yes scriptspect@0.1.2 .
npx --yes scriptspect@0.1.2 . --fix-dry-run
```

Repository and real before/after example: https://github.com/Tom409114/scriptspect

I'd especially value feedback on confusing findings or scripts that work on one OS but fail on another. Please include the script and target shell. The goal of this first release is useful, reviewable diagnostics.

## 中文首发 — 草稿

**标题：** 做了个开源工具：提前找出 package.json 里“Mac 能跑、Windows 报错”的脚本

维护 JS/TS 项目时，经常遇到代码没问题，构建脚本却因为操作系统不同而失败。

比如 `NODE_ENV=production vite build` 和 `rm -rf dist`，到了 Windows 默认 cmd 环境就可能出问题。我做了 ScriptSpect：读取 package.json，指出具体命令片段、受影响的 shell 和原因，并在满足条件时给出可预览的修复补丁。

它不会执行被检查的脚本。可以扫描 monorepo，输出 JSON，也能接入 GitHub Actions，在 PR 中显示标注。

在项目目录运行（需要 Node.js 22+）：

```bash
npx --yes scriptspect@0.1.2 .
npx --yes scriptspect@0.1.2 . --fix-dry-run
```

项目和真实演示：https://github.com/Tom409114/scriptspect

想请维护跨平台项目的朋友试试看。最希望收到的是：哪条提示看不懂、有没有误报，以及哪些脚本曾经让你在另一个系统上踩坑。附上脚本和 shell 就很有帮助。

## 25-second demo storyboard

Use [the committed demo](assets/demo/terminal.svg) and [its patch](assets/demo/fix.patch). This storyboard is not a claim that a video has been rendered.

| Time | Screen | Caption |
| --- | --- | --- |
| 0–5s | Two original package scripts | Works on my Mac. What about Windows? |
| 5–12s | Real analyzer output | See the command, shell and reason. |
| 12–20s | Actual dry-run patch | Preview the fix before changing files. |
| 20–25s | Install command + repository URL | Try it on your own package.json. |

Preserve the fixture's declared cross-env/rimraf dependencies in the demonstration. Do not imply the tool installs them automatically.

## Feedback log

No outreach results are recorded yet. For each real trial, record only what the tester agrees to share: channel, repository or anonymized example, successful first run, confusion/false positives, and a link to any resulting issue. Review after the first 5–10 trials before expanding promotion.
