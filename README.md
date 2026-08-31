[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/brand/hero.svg" width="100%" alt="ScriptSpect analyzes package scripts for POSIX shell, Windows cmd, and PowerShell portability problems before the scripts run">
</p>

<p align="center">
  <a href="https://github.com/Tom409114/scriptspect/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Tom409114/scriptspect/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-6f7bf7.svg"></a>
</p>

<p align="center"><strong>One script. Multiple shell interpretations. A finding tied to the target that breaks.</strong></p>

ScriptSpect statically checks npm-style `package.json` scripts without running
them. It identifies constructs that mean different things to `posix-sh`,
Windows `cmd`, or optional `powershell`, points to the relevant span, and keeps
automatic fixes behind explicit safety gates.

> [!IMPORTANT]
> This repository is a **pre-release source evaluation**. The npm package and
> public Action tag do not exist yet; the copy-paste paths below deliberately
> use an immutable source commit.

**[See the real demo](#before-result-and-after)** · **[Evaluate from source](#evaluate-from-source-pre-release)** · **[GitHub Actions](#github-actions-preview-pre-release)** · **[Rules](docs/rules/README.md)**

<!-- readme-section: why -->
## Why it is useful

| Catch the breakage | Explain the target | Keep fixes reviewable |
| --- | --- | --- |
| Finds shell-dependent commands, operators, expansion, redirection, paths, and undeclared executables before another OS runs them. | Every finding carries a stable rule ID, package/script path, source span, severity, confidence, and affected targets. | `safe`, `conditional`, and `manual` classes prevent “helpful” rewrites when equivalence cannot be proved. |

ScriptSpect uses a target-specific structural parser rather than scanning quoted
text with a stack of regular expressions. It is intentionally not a full shell
interpreter: findings should still be reviewed in the project that owns the
script.

<!-- readme-section: evaluate -->
## Evaluate from source (pre-release)

Requires Node.js 22 or newer and pnpm via Corepack. Clone the repository, check
out the reviewed commit, install exactly from the lockfile, build, and scan the
versioned demo fixture. Findings exit `1`; a clean scan exits `0`; invalid input,
configuration, or I/O exits `2`.

```bash
git clone https://github.com/Tom409114/scriptspect.git
cd scriptspect
git checkout 13dfcfcec3f50c3dd786a1f9b2a4225391ded0e5
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.mjs tests/fixtures/readme-demo
```

There is deliberately no `npx scriptspect` quick start yet. The machine-readable
release state is [docs/readme-status.json](docs/readme-status.json).

<!-- readme-section: demo -->
## Before, result, and after

Everything here is generated from the versioned
[demo fixture](tests/fixtures/readme-demo/package.json), so the screenshot and
patch cannot drift away from executable behavior.

**Before — two scripts that assume a POSIX shell:**

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

**Result — `PS001` and `PS010` identify the exact cmd-incompatible spans:**

![Generated terminal transcript showing ScriptSpect findings for PS001 and PS010](docs/assets/demo/terminal.svg)

[Selectable terminal text](docs/assets/demo/terminal.txt) · [Full generated patch](docs/assets/demo/fix.patch) · [Verified after file](docs/assets/demo/package.after.json)

**After — the conditional rewrites use dependencies already declared by the project:**

```diff
-"build": "NODE_ENV=production vite build"
-"clean": "rm -rf dist"
+"build": "cross-env NODE_ENV=production vite build"
+"clean": "rimraf dist"
```

`--fix-dry-run` prints this patch without writing. `--fix` uses staged writes,
post-write analysis, and a recovery journal; it never installs dependencies or
rewrites a lockfile. Regenerate all demo assets with
`pnpm exec tsx tools/generate-readme-demo.ts`.

<!-- readme-section: cli -->
## CLI at a glance

The source build supports human, JSON, and GitHub-friendly output, focused rule
runs, explicit target matrices, and opt-in fixes.

```bash
node dist/cli.mjs [path]
node dist/cli.mjs [path] --format json
node dist/cli.mjs [path] --target posix-sh,cmd,powershell
node dist/cli.mjs [path] --rule PS001,PS010
node dist/cli.mjs [path] --fix-dry-run
node dist/cli.mjs [path] --fix
node dist/cli.mjs explain PS010
```

Presentation filters do not hide failure semantics: any configured `error`
fails, and the unfiltered warning count is compared with `--max-warnings`.

<!-- readme-section: action -->
## GitHub Actions preview (pre-release)

This complete example checks out both the consumer and an immutable ScriptSpect
source commit, then runs the bundled local Action. Do not replace the commit
with the nonexistent `Tom409114/scriptspect@v0.1` tag. After a verified release,
security-sensitive workflows should continue pinning a full commit SHA.

```yaml
name: scriptspect pre-release evaluation
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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: Tom409114/scriptspect
          ref: 13dfcfcec3f50c3dd786a1f9b2a4225391ded0e5
          path: .scriptspect
          persist-credentials: false
      - uses: ./.scriptspect
        with:
          path: .
```

The Action writes annotations, a job summary, and numeric outputs named
`exit-code`, `packages`, `scripts`, `errors`, `warnings`, and `advisories` before
marking a finding run as failed. Its default mode is read-only.

<!-- readme-section: config -->
## Minimal configuration

Defaults target `posix-sh` and `cmd`. Put the same small contract in the root
`package.json` under `scriptspect`, or in `scriptspect.config.json`:

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

Precedence is deterministic and replacement-based:
`--config` → `package.json#scriptspect` → `scriptspect.config.json` → defaults.
`--target` then replaces only the selected config's target list. Config sources
are never merged. Ignore entries must name rules and should stay narrow enough
to explain an intentional platform-specific script.

Contracts: [config JSON Schema](schema/config.schema.json) · [JSON output Schema](schema/output.schema.json)

<!-- readme-section: support -->
## Scope and honest limits

| Area | Current source-evaluation behavior |
| --- | --- |
| Projects | root `package.json` plus npm/Yarn/Bun workspaces and `pnpm-workspace.yaml` |
| Targets | `posix-sh` + `cmd` by default; opt-in `powershell` evidence |
| Findings | error, warning, and advisory with high/medium confidence |
| Output | stylish terminal text, versioned JSON, GitHub annotations + summary |
| Fixes | dry-run plus provable safe/conditional rewrites; ambiguous cases stay manual |
| Privacy | offline analysis; scripts are not executed; no telemetry |
| Release | pre-release; no npm package or public Action reference yet |

The homepage does not claim external adoption, measured precision, comparative
superiority, hosted performance, or completed release gates. The
[validation ledger](docs/validation/spec-compliance-2026-09-01.md) keeps
repository-controlled work separate from evidence that only real users and a
public release can create.

<!-- readme-section: faq -->
## FAQ and troubleshooting

**Does it run my scripts?** No. It reads package manifests and performs static
structural analysis.

**Why did the scan exit `1` when I filtered warnings from the display?** Failure
is calculated before presentation filtering: configured errors and the full
warning budget still count. Use `--format json` to inspect the complete contract.

**Why was no automatic fix offered?** The parser must agree on the replacement's
structural role across active targets, and conditional fixes require the exact
dependency to be declared. Otherwise the finding remains explanatory and manual.

**Which config won?** Explicit `--config` wins, followed by the `package.json`
field, the standalone file, then defaults. Non-default sources are reported in
human-readable output.

**Can I use it in production CI today?** Treat this source checkout as an
evaluation build. Wait for public npm, Release, provenance, checksum, and
immutable Action-consumer evidence before depending on a released reference.

<!-- readme-section: navigation -->
## Go deeper

- [Documentation index](docs/README.md)
- [All rules](docs/rules/README.md)
- [Architecture and parser contract](docs/architecture.md)
- [Comparison boundary](docs/comparison.md)
- [Compliance audit](docs/validation/spec-compliance-2026-09-01.md)
- [Corpus methodology](docs/evidence/corpus-method.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Roadmap](docs/roadmap.md)
- [Evidence policy](docs/evidence/README.md)

<!-- readme-section: license -->
## License

[MIT](LICENSE)
