# Comparison: scriptspect vs scripts-doctor

[scripts-doctor](https://github.com/Ashwani2529/scripts-doctor) (MIT) lints and auto-fixes package.json scripts for cross-platform reliability. It proved real demand for this problem space. scriptspect exists to go substantially further on accuracy and CI ergonomics — not to rebrand the same tool. This page is a factual comparison; if it drifts from reality, please open an issue.

## Feature parity baseline (must-have; verified against the scripts-doctor README as of 2026-08-30)

| scripts-doctor capability | scriptspect | How we do it better |
| --- | --- | --- |
| Scan package.json scripts | ✅ | + workspace/monorepo auto-discovery (npm/pnpm/Yarn/Bun) |
| `rm -rf` → rimraf advice | ✅ (PS010) | fix safety classes; auto-apply only when provably safe |
| `cp`/`mv`/`mkdir -p`/`grep`/`sed`/`cat` → shx | ✅ (PS011–PS019) | one explainable rule per command, not one big rewrite |
| `FOO=bar cmd` → cross-env | ✅ (PS001) | detects existing cross-env usage; no double advice |
| Missing local bin / devDependency | ✅ (PS040) | workspace-bin aware (no false "missing" for workspace tools) |
| Chained / subshell risk | ✅ (M1 IR) | `&&`/`\|\|` are legal on both sh and cmd — only true semantic mismatches are reported (PS050, advisory) |
| `--fix` | ✅ (M4) | safety tiers (safe/conditional/manual), dry-run diff, never installs deps or touches lockfiles |
| stylish / json output | ✅ (M3) | + versioned machine-readable JSON schema + github annotations format |
| `--quiet` / `--no-color` / `--help` / `--version` | ✅ (M3) | full CLI parity |
| Exit codes 0/1/2 | ✅ (M3) | documented contract |
| Explicit project path | ✅ (M3) | root/path + workspace selection in CI |
| Runs in CI | ✅ (M3/M6) | from a manual `npx` step to a first-class Action with annotations + job summary |

## Differentiation contract — where scriptspect must be clearly better

| Dimension | Commitment |
| --- | --- |
| Shell-aware parsing | quote/escape/operator-aware lexer → token stream → command IR. Strings like `echo "rm -rf dist"` or `node -e "console.log('cp -r')"` never false-positive; quoted `&&` never splits |
| Target shell matrix | every finding lists affected shells (posix-sh / cmd / powershell); default matrix = npm defaults (sh + cmd) |
| Confidence + severity | every rule has confidence (high/medium) and severity (error/warn/advisory); CI fails only on high-confidence errors by default |
| Rule provenance | each rule documents shell-behavior evidence and real failure classes with good/bad examples |
| Monorepo first-class | npm/pnpm/Yarn/Bun workspace discovery, per-package reporting, 100-package repo in under 2 seconds |
| Safe fix engine | safe / conditional / manual; `--fix` applies only provably-safe fixes; idempotent; preserves formatting |
| No execution | static only — safe to run on untrusted PRs |
| GitHub-native | first-class Action, PR annotations, job summary; SARIF planned |
| Package-manager neutral | npm / pnpm / Yarn / Bun |
| Extensible rules | standalone rule modules with typed metadata + fixtures; new rules don't touch the parser |

## Release gate

v0.1 is not published if, next to scripts-doctor's README, the honest conclusion is "same features, different name". The bar: on a shared fixture corpus, scriptspect must find real issues scripts-doctor misses — without trading in more false positives.

## Relationship to cross-env / shx / rimraf

These are remedies, not competitors. scriptspect finds problems and recommends exactly these tools when they are the right fix.
