# scriptspect

**Static analyzer for `package.json` scripts — catches shell-specific commands before they break Windows, macOS, or Linux builds.**

Like ShellCheck, but for npm/pnpm/Yarn/Bun scripts. `scriptspect` parses every script in your project (including monorepo workspaces), flags commands that only work in some shells, explains *why* they fail, and — when it is provably safe — offers the fix.

## Try it in one command

```bash
npx scriptspect
# or: pnpm dlx scriptspect / bunx scriptspect
```

Zero config. It finds your project root, discovers your workspaces, and analyzes every script against the shells npm actually uses (`sh` on macOS/Linux, `cmd.exe` on Windows).

## What it looks like

<!-- Sample output reflects the reporter format shipped in v0.1 (milestones M3–M8). -->

```text
package.json  ›  scripts.build

PS001  error  HIGH  POSIX inline env assignment `NODE_ENV=production` is not portable to cmd.exe
       NODE_ENV=production vite build
       ^^^^^^^^^^^^^^^^^^^
       Affected: cmd
       Fix: add cross-env as a devDependency, then wrap the assignment
       Learn more: https://github.com/Tom409114/scriptspect/blob/main/docs/rules/PS001.md

packages/web/package.json  ›  scripts.clean

PS010  error  HIGH  `rm -rf` is not available in native Windows npm scripts
       rm -rf dist
       ^^
       Affected: cmd
       Fix: add rimraf (or shx) as a devDependency, then re-run --fix
       Learn more: https://github.com/Tom409114/scriptspect/blob/main/docs/rules/PS010.md

Scanned 2 scripts across 2 packages · 2 errors · 0 warnings
```

Every finding carries a stable rule ID, the exact script and span, the affected shells, a confidence level, and an actionable fix path.

## Why

npm scripts run through `sh` on macOS/Linux and `cmd.exe` on Windows. `rm -rf dist`, `FOO=bar node .`, `mkdir -p`, `$(...)` are all fine on a Mac and broken on a Windows contributor's machine — usually minutes after they clone. Existing tools sprinkle `cross-env`/`shx` advice one crash at a time; `scriptspect` checks the whole project statically, in CI, before the PR merges.

Key properties:

- **Shell-aware parsing** — quote/escape/operator-aware lexer + command IR, not regex stacking. Strings like `echo "rm -rf dist"` never false-positive.
- **Target shell matrix** — every finding says which shells break: `posix-sh`, `cmd`, `powershell`.
- **Confidence + severity** — `high`/`medium` confidence, `error`/`warn`/`advisory` severity; CI fails only on high-confidence errors by default.
- **Monorepo first-class** — npm/pnpm/Yarn/Bun workspaces, per-package findings.
- **Safe fixes only** — `safe` / `conditional` / `manual` fix classes; `--fix` never installs dependencies or rewrites lockfiles; `--fix-dry-run` shows the diff first.
- **No execution, no telemetry, no AI** — pure static analysis, deterministic and offline. Your scripts are never run; your code never leaves the machine.

## Support matrix

| Capability | v0.1 status |
| --- | --- |
| package.json scripts (single package) | ✅ |
| npm / Yarn / Bun workspaces | ✅ |
| pnpm-workspace.yaml | ✅ |
| Targets: posix-sh + cmd (npm defaults) | ✅ |
| powershell target (opt-in) | ✅ |
| Formats: stylish / json / github annotations | ✅ |
| Safe + conditional auto-fix with dry-run | ✅ |
| GitHub Action | ✅ |
| SARIF output | 🚧 later |

Rules: [docs/rules](docs/rules) — each with why/bad/good examples, false-positive notes, fix safety, and provenance.

## Relationship to other tools

- **[scripts-doctor](https://github.com/Ashwani2529/scripts-doctor)** — a package-scripts linter with overlapping basics (rm→rimraf, cross-env suggestions, missing-bin checks, `--fix`). We cover the same basics; our edge is a shell-aware parser, per-shell target matrix, confidence/severity tiers, monorepo discovery, and a CI-grade safe-fix engine. See [docs/comparison.md](docs/comparison.md).
- **cross-env / shx / rimraf** — these *fix* portability problems; `scriptspect` *finds* them and tells you when one of these tools is the right fix. Complements, not competitors.
- **ShellCheck** — the mental model (rule IDs, explainable diagnostics, static analysis) applied to package scripts.

## Use it in CI

The GitHub Action runs the same CLI core, emits inline annotations plus a job summary, and fails the job on findings:

```yaml
- uses: Tom409114/scriptspect@v0.1
  with:
    path: .            # project path to analyze (default: repository root)
    target: posix-sh,cmd
```

Or call the CLI directly:

```yaml
- run: npx scriptspect --format github
```

## Configure

Zero config works. To tune, add a `scriptspect` field to package.json or a `scriptspect.config.json`:

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

A published JSON Schema gives editor completion for every field.

## Status

All milestones [M0–M8](docs/roadmap.md) are merged and CI-green on main; the M8 corpus validation gate is underway. Rule IDs are a stable API once published; semantic changes are tracked in release notes.

## License

[MIT](LICENSE)
