# Comparison: scriptspect vs scripts-doctor

[scripts-doctor](https://github.com/Ashwani2529/scripts-doctor) (MIT) lints and auto-fixes package.json scripts for cross-platform reliability. ScriptSpect addresses the same problem with a different parser, evidence model, and CI contract. The surface table below is not a quality claim; the later reviewed result is limited to seven fixed, repository-owned questions.

## Documented surface baseline

Checked against the scripts-doctor `1.0.0` README and package metadata on
2026-09-01. The exact competitor package and integrity used by this repository
are pinned in [`comparison/toolchain.json`](../comparison/toolchain.json).

| scripts-doctor capability | ScriptSpect implementation | Distinct contract (not a quality claim) |
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
| Runs in CI | source preview implemented; released consumer pending | bundled Action, annotations, numeric outputs, and job summary; no public tag yet |

## Differentiation contract — where scriptspect must be clearly better

| Dimension | Commitment |
| --- | --- |
| Shell-aware parsing | quote/escape/operator-aware target parses → token stream → command IR. Regression fixtures require quoted command text and quoted operators to remain data |
| Target shell matrix | every finding lists affected shells (posix-sh / cmd / powershell); default matrix = npm defaults (sh + cmd) |
| Confidence + severity | every rule has confidence (high/medium) and severity (error/warn/advisory); any configured `error` is in the failure universe, and the warning budget is evaluated before display filtering |
| Rule provenance | each rule documents shell-behavior evidence and real failure classes with good/bad examples |
| Monorepo first-class | npm/pnpm/Yarn/Bun workspace discovery and per-package reporting; the controlled hosted 100-package/2-second benchmark passed in [run `33501069632`](https://github.com/Tom409114/scriptspect/actions/runs/33501069632) at exact candidate commit `b514d367b9922b1180e1b1efa500ff22bd014902`, but it is implementation evidence rather than an external-corpus performance or adoption claim |
| Safe fix engine | safe / conditional / manual; `--fix` applies only replacements whose structural and dependency preconditions are proved; idempotency and formatting are regression-tested |
| No execution | static only — safe to run on untrusted PRs |
| GitHub-native | first-class Action, PR annotations, job summary; SARIF planned |
| Package-manager neutral | npm / pnpm / Yarn / Bun |
| Extensible rules | standalone rule modules with typed metadata + fixtures; new rules don't touch the parser |

## Reviewed shared-fixture result

The executable [shared-corpus harness](../comparison/README.md) captured both
tools at exact ScriptSpect source
`b514d367b9922b1180e1b1efa500ff22bd014902` under Node `22.23.2` and the
pinned package toolchain. The versioned [2026-09-01
review](../comparison/evidence/2026-09-01/README.md) independently checked all
14 tool/fixture observations; all 14 secondary decisions agreed with the final
primary decisions.

On these seven fixed questions, ScriptSpect was correct on 7/7. The
`scripts-doctor@1.0.0` baseline had 2 correct results, 2 false positives, and 3
false negatives. ScriptSpect identified command substitution, POSIX environment
expansion, and target-specific separator semantics that the baseline missed,
while avoiding false positives on quoted command text and an already-declared
executable.

This satisfies the v0.1 specification's narrow shared-fixture differentiation
bar without claiming ecosystem-wide superiority. Public-corpus precision is
measured and reported separately, and future comparison changes must retain the
same pinned-input, raw-output, and independent-review contract.

## Relationship to cross-env / shx / rimraf

These are remedies, not competitors. scriptspect finds problems and recommends exactly these tools when they are the right fix.
