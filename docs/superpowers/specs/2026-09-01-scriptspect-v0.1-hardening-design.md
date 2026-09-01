# ScriptSpect v0.1 correctness, release, and onboarding design

Date: 2026-09-01

Status: approved direction; repository design record pending maintainer review

Baseline: `main` at `d0650a7e232f720badec6f6be806c13f8e2fa25c`

## 1. Purpose

Bring ScriptSpect to a truthful, releasable v0.1 that matches the engineering specification rather than merely containing the named files. The release must be accurate across npm's default POSIX `sh` and Windows `cmd.exe` execution models, safe when applying fixes, usable as a revision-pinned GitHub Action, recoverable when publishing fails, and immediately understandable from an English or Simplified Chinese GitHub homepage.

The versioned [baseline compliance ledger](../../validation/spec-compliance-2026-09-01.md) found 212 requirements or evidence gates: 73 failed, 90 were partial, 36 passed, 12 lacked enough evidence, and one was time-bound. The implementation closes repository-controlled failures and labels external adoption gates honestly; it does not manufacture stars, users, feedback, issues, or downstream repositories.

## 2. Goals

1. Make command boundaries, quoting, escaping, redirection, expansion, and wrappers target-aware.
2. Make every high-confidence finding and every automatic replacement traceable to a target-specific parse and exact source span.
3. Prevent all configuration and manifest reads or writes from escaping the canonical analysis root.
4. Make `--fix` deterministic, root-aware, concurrency-aware, and recoverable across multiple manifests.
5. Make runtime config validation and the published JSON Schema one contract.
6. Make CLI display and exit behavior explicit and testable, including `--no-color` and warning budgets.
7. Replace the network-dependent composite Action with a bundled Node 24 action tied to the referenced repository revision.
8. Make CI read-only for pull requests, lockfile-frozen, coverage-gated, cross-platform, and capable of consuming `uses: ./` for real.
9. Build and checksum one npm tarball, publish that exact tarball, verify registry integrity, and retain a documented retry path.
10. Publish complete English and Simplified Chinese homepages backed by a deterministic, reproducible demonstration fixture.
11. Correct roadmap, validation, evidence, and Definition-of-Done claims so public statements never outrun public proof.

## 3. Non-goals

- A complete Bash, cmd.exe, or PowerShell interpreter.
- Running package scripts to infer behavior.
- Installing replacement dependencies or changing lockfiles during `--fix`.
- A GUI, hosted service, telemetry, AI runtime, dependency vulnerability scanner, or general repository doctor.
- Fabricating adoption evidence or automatically writing issues, pull requests, comments, or mentions to third-party repositories.
- Advertising a `v1` Action tag before a real 1.x release.
- Treating a local or single-OS test result as proof of the cross-platform release gate.

## 4. Delivery shape

### 4.1 Operational constraints

The source specification's agent instructions are audited as historical project-process requirements, not treated as higher-priority instructions for this task. The current user explicitly authorized an isolated local worktree. Applicable repository safeguards still govern delivery:

- all implementation occurs on feature branches and reaches `main` through reviewable pull requests;
- each change set is normally below 800 authored, non-generated lines or explains why it cannot be split safely;
- hosted Actions, not local output, are the final cross-platform acceptance evidence;
- pull requests record scope, tests, semantic risks, supply-chain changes, and rollback;
- no workflow or agent writes to a third-party repository without separate user approval;
- adoption and feedback are never synthesized from self-owned demos;
- GitHub remains the public source of truth once a change is pushed.

Before bootstrap publication, the coordinator rechecks npm package-name availability and ownership for `scriptspect`. The GitHub repository-name gate is already satisfied by the user-owned repository. A newly claimed or disputed npm name blocks publication and triggers an explicit naming decision rather than an automatic rename.

### 4.2 Change sets

The work is reviewed in five bounded change sets, each independently testable and normally kept below the specification's 800-line non-generated review budget. Generated Action bundles, schemas, rule references, and demo assets are reported separately from authored-code size.

1. **Core correctness and safety** — target parse matrix, rule truth, config/root boundaries, fixer safety, schemas, CLI semantics, workspace bins, line endings, coverage.
2. **First-class GitHub Action** — bundled Node 24 entry point, validated inputs/outputs, local consumer jobs, annotations and summary assertions.
3. **CI and release hardening** — frozen installs, minimum permissions, single tarball, checksums, draft/retry behavior, npm bootstrap and OIDC transition, verified aliases.
4. **Bilingual onboarding** — English and Chinese README parity, generated terminal demo, real before/after, Action workflow, FAQ and docs landing.
5. **Evidence and final verification** — reproducible corpus inputs, comparison limits, roadmap corrections, branch rules, and a requirement-by-requirement v0.1 DoD report.

No release PR is merged until the first four change sets are green. PR #62 is superseded or regenerated after the corrected release state is on `main`.

## 5. Target-aware parser architecture

### 5.1 Why the current architecture must change

The current lexer calls itself shell-agnostic but simultaneously treats POSIX single quotes and backslashes and cmd.exe carets as universal syntax. Once those characters are consumed, rules cannot recover the other shell's command boundary.

Examples already reproduced against the current analyzer:

- `echo 'safe & rm -rf dist'`: POSIX prints text; cmd.exe executes a second `rm` command. Current result: no finding.
- `echo foo \& rm -rf dist`: POSIX keeps `&` literal; cmd.exe executes `rm`. Current result: no finding.
- `echo foo ^& rm -rf dist`: cmd.exe keeps `&` literal; POSIX starts a second command. Current result: no finding.
- `echo '%APPDATA%'`: cmd.exe expands the variable despite single quotes; POSIX does not. Current result: no finding.
- `echo ^> /dev/null`: cmd.exe has no redirection, while POSIX does. Current PS025 target is wrong.

These are structural failures, not missing regular expressions.

### 5.2 Parse model

The raw script remains the sole source of spans. Semantic tokenization and parsing occur separately for every active target.

```ts
type ParseTarget = 'posix-sh' | 'cmd' | 'powershell';

interface ParseDiagnostic {
  code: string;
  message: string;
  span: [number, number];
  severity: 'error' | 'advisory';
}

interface TargetParse {
  target: ParseTarget;
  root: ScriptNode;
  diagnostics: ParseDiagnostic[];
}

interface ParseMatrix {
  source: string;
  activeTargets: ReadonlySet<ParseTarget>;
  byTarget: ReadonlyMap<ParseTarget, TargetParse>;
}
```

`ParseMatrix` separates evidence parses from affected targets. It always contains POSIX and cmd evidence parses, adds every active target, and adds an origin dialect required by a selected rule (PowerShell for PS003/PS032 and explicit PowerShell wrappers). This is the deterministic `requiredEvidenceTargets(activeTargets, selectedRules)` algorithm. Findings, PS051 diagnostics, counts, and exit behavior are emitted only for active targets; an evidence-only parse can establish what the source means in another dialect but never independently creates a finding or failure.

Every token and IR node retains a source span into `ParseMatrix.source`. A source span may legitimately be a word in one target and an operator, redirection, or quote boundary in another. Decoded token values are never reused across dialects.

### 5.3 Dialect contracts

**POSIX sh** models single and double quotes, POSIX backslash rules, `$VAR`, `${...}`, `$()`, `;`, `&`, `&&`, `||`, pipelines, groups, and the redirections needed by the v0.1 rules. A caret is ordinary text.

**cmd.exe** models double-quote grouping, caret escapes, `%VAR%`, `&`, `&&`, `||`, pipes, groups, and cmd redirections. A single quote and a backslash are ordinary characters for command-boundary purposes. A semicolon is not a command separator.

**PowerShell** is explicitly defined as PowerShell 7+ for the optional target, but v0.1 implements only the lexical subset needed by PS003, PS025, PS032, quote safety, redirection operands, and explicit `pwsh`/`powershell -Command` wrappers. The subset includes single/double quotes, backtick escapes, `$env:NAME`, semicolon and pipeline boundaries, and exact wrapper payload extraction. All other PowerShell constructs produce an `unsupported-subset` advisory and disable automatic replacement for the intersecting span. POSIX or cmd semantics are never silently substituted. Expanding the subset requires a documented grammar boundary, primary-source oracle, and golden fixtures.

### 5.4 Parser diagnostics

Unterminated quotes, unbalanced groups, unsupported target constructs, and source regions that cannot be assigned a safe command boundary are normal analysis diagnostics, not internal exceptions. A new documented rule, `PS051 TARGET_SHELL_PARSE_ERROR`, exposes them with this normative contract:

| Diagnostic subtype | Finding severity/confidence | Effect |
|---|---|---|
| deterministic syntax failure for an active target | `error/high` | participates in exit 1; no fix |
| analyzer-supported-subset boundary | `advisory/medium` | visible, does not fail by default, gates intersecting fixes |

PS051 registry metadata has the static target upper bound `['posix-sh', 'cmd', 'powershell']`, defaults to `advisory/medium`, and has no automatic fix. Each finding contains only the dynamic active target whose parse produced the diagnostic and uses the smallest raw source span that establishes it. Per-finding overrides create `error/high` only when a primary-source-backed fixture proves that the selected target rejects the syntax. It is selectable through `--rule`, configurable through severity overrides, suppressible through the same precise package/script/rule ignore contract, and emitted only for active targets. Definite syntax errors inside a recognized wrapper payload are reported with source-mapped spans; ordinary inner portability findings remain suppressed. Unsupported wrapper payloads receive only the advisory subtype.

Internal parser exceptions remain exit code 2. A user's syntactically invalid package script is a finding, not a tool crash.

### 5.5 Wrapper payloads

`bash -c`, `sh -c`, `cmd /c`, `powershell -Command`, and `pwsh -Command` retain an exact `payloadSourceSpan` and derive `payloadRaw` only through `source.slice(payloadSourceSpan[0], payloadSourceSpan[1])`. Decoded token values are never joined to reconstruct source. The wrapper executable and flag must be literal tokens in one outer simple-command node.

For `bash -c`/`sh -c`, the payload is exactly the argument immediately after `-c`; later arguments are shell `$0`/positional arguments and are not payload. For `cmd /c` and PowerShell `-Command`, the candidate payload is the raw remainder of the same outer simple-command node after the flag; an operator or newline that the outer parser classified outside that node is not payload. Removable outer quote delimiters are excluded only when the interior bytes are exactly the bytes delivered to the wrapper. V0.1 accepts nested parsing only when the delivered payload is representable as one contiguous source slice with no outer expansion, escape transformation, concatenation, or ambiguous quote stripping. Every other case emits the PS051 `unsupported-wrapper-boundary` advisory and disables nested findings and fixes. Golden fixtures define `/c`, `/C`, `-Command`, `-c`, quoted/unquoted remainder, outer separators, escaped operators, and extra positional arguments for every outer dialect.

The payload parser target is always the explicit wrapper shell, not the outer active target. Inner node spans are translated back to top-level source coordinates. Nested wrappers repeat the same mapping and exact-slice eligibility test.

The payload is parsed with the explicitly selected wrapper dialect. Inner portability rules remain suppressed to avoid duplicate noise; the explicit-shell rule explains the dependency. Definite payload syntax errors remain reportable through PS051. The inner IR is otherwise available for explain output and future rules.

### 5.6 Rule evaluation

Rules consume `ParseMatrix`, not one blended `ScriptIr`. This table is normative:

| Rule(s) | Evidence parse | Affected target derivation | Source-span owner | Automatic-fix gate |
|---|---|---|---|---|
| PS001 | POSIX leading-env node plus comparison target graph | active non-POSIX target where the assignment is not equivalent | POSIX assignment span | stable insertion/assignment span across active parses and `cross-env` is a declared executable dependency |
| PS002 | cmd `set NAME=value` command/chain | active POSIX/PowerShell target where cmd assignment semantics do not apply | cmd command/assignment span | no v0.1 replacement unless every active parse agrees and `cross-env` is usable |
| PS003 | PowerShell `$env:` assignment evidence | active POSIX/cmd targets | PowerShell expansion/assignment span | manual/conditional only in v0.1 |
| PS010–PS019, PS021–PS022 | command nodes in each affected target parse, principally cmd for POSIX commands | only targets in which that command actually executes and is unavailable/incompatible | affected target's `argv[0]` or required flag span | identical raw command role across active parses plus declared usable replacement bin |
| PS020, PS023 | POSIX expansion nodes | active targets without equivalent expansion, principally cmd | POSIX expansion span | no replacement unless all active parses agree on the containing word |
| PS024 | cmd `%NAME%` expansion node | active non-cmd targets | cmd expansion span | manual in v0.1 |
| PS025 | `/dev/null` classified as a redirection or file operand by the affected target parse | cmd/PowerShell targets where that operand would be used and unavailable | affected target operand span | manual; POSIX-only redirection divergence is PS050, not PS025 |
| PS026 | Unix absolute-path operand in each active non-POSIX parse | the target parse that would consume the path | affected target operand span | manual |
| PS030–PS032 | exact outer wrapper node and raw executable/flag spans | active targets lacking or contradicting that explicit shell | outer source span | manual; inner portability replacements suppressed |
| PS040 | executable command nodes from every active target parse | each target where the command executes but no visible declared bin resolves | that target's `argv[0]` span | plan only; never installs a dependency |
| PS041 | executable suffix on a command node in each active target parse | active non-Windows target where the command executes | affected target's `argv[0]` span | manual |
| PS050 | comparison of active target command/operator/redirection graphs | targets whose graphs differ at the source span | raw divergent operator/quote/escape span | manual |
| PS051 | target-local parser diagnostic | only the diagnostic's active target | smallest diagnostic raw span | never |

Duplicate evidence is merged by `(ruleId, source span, finding subtype, replacement text)` with a deterministic union of affected targets. Human-readable messages are rendered after merging and are not identity keys. A replacement is omitted whenever active targets disagree about the replacement span's structural role or a relevant parse diagnostic intersects it.

This preserves the existing rule metadata and reporter contract while making `affectedTargets` a fact derived from target semantics.

## 6. Configuration, schemas, and root boundaries

### 6.1 Canonical root policy

Root discovery may test only for the existence of candidate `package.json` files; it does not parse one before the boundary is established. ScriptSpect keeps a user-facing logical root and a security-critical canonical root directory. It resolves the chosen directory and root manifest with `realpath`; any failure is exit 2. Package paths are calculated from canonical file locations relative to the canonical root and normalized to POSIX separators, while user-facing invocation context may retain the logical start path.

Before reading a root manifest, workspace manifest, default config, or explicit config, ScriptSpect resolves the file's real path and verifies that the file is a descendant of the canonical root directory. Equality is valid only when comparing the root directory to itself, never when comparing a file to the directory. The check is repeated immediately before a write.

An explicit `--config` path is resolved relative to the analysis root. Absolute paths are accepted only when their canonical target is inside the root. `..`, directory symlinks, and file symlinks cannot escape. Rejections use exit code 2 without echoing external file contents.

Workspace glob results remain root-contained and deduplicated. A failed realpath is an I/O error, not permission to fall back to an unchecked path.

### 6.2 Config precedence

Configuration sources are intentionally replacement-based rather than implicitly merged:

1. explicit `--config` file;
2. root `package.json` `scriptspect` field;
3. root `scriptspect.config.json`;
4. defaults.

CLI `--target` overrides the selected config's targets. `--severity` remains a display threshold, not a rule-severity override. This precedence and distinction are documented in both languages and covered by a table-driven test matrix.

### 6.3 Strict validation and schema parity

Runtime validation rejects unknown root keys, unknown ignore-entry keys, unknown rule IDs, invalid values, and duplicate targets exactly as the schema does. Every ignore entry must contain a non-empty `rules` array; `packages` and `scripts` may further narrow it. Package-only or script-only suppressions, including `**`, are rejected as a deliberate pre-release contract tightening. Migration examples show users how to enumerate the intended rules. Every applied suppression is therefore traceable to explicit rule IDs.

Generated artifacts:

- `schema/config.schema.json` — generated from the runtime rule registry and config contract, with stable `$id` `https://unpkg.com/scriptspect/schema/config.schema.json`;
- `schema/output.schema.json` — the versioned JSON reporter contract, with stable `$id` `https://unpkg.com/scriptspect/schema/output.schema.json`.

The generated files under `schema/` are the only schema copies admitted to `npm pack`; `package.json.files` includes `schema`, and both README languages point to the stable paths. The generator imports the rule registry and a typed config contract. Runtime uses explicit validation, while an AJV-based test validator checks the generated JSON Schema against the same declarative valid/invalid fixture corpus. CI regenerates schemas, fails on a diff, checks pack contents, and verifies the public `$id` paths after release.

## 7. Fixer safety and file transactions

### 7.1 Root-aware JSON editing

The fixer stops locating `"scripts"` with an unscoped regular expression. A strict JSON concrete-syntax tree identifies the root object's direct `scripts` property and exact string-value spans. The input policy is fixed before editing:

| Input | Analyze/check behavior | `--fix` behavior |
|---|---|---|
| strict UTF-8 JSON | analyze | eligible |
| leading UTF-8 BOM | accept and remember the BOM | eligible and byte-preserve the BOM |
| nested non-root object named `scripts` | ignore as npm metadata | never edit it |
| duplicate root `scripts` or duplicate key inside root `scripts` | exit 2 as ambiguous manifest | refuse, original unchanged |
| comment or trailing comma | exit 2 as non-standard package JSON | refuse, original unchanged |
| non-string root script value | exit 2 with exact script key | refuse, original unchanged |
| invalid escape/Unicode or other malformed JSON | exit 2 | refuse, original unchanged |

Only changed root script string literals are replaced. Indentation, field order, line endings, final newline, Unicode spelling, and every unrelated byte remain stable.

### 7.2 Dependency-gated replacements

`safe` still means no dependency installation and a locally provable rewrite. `dependencies` and `devDependencies` may satisfy a bin precondition. Optional and peer declarations remain conditional unless executable availability is independently established. Workspace bins are derived only from real `bin` declarations:

- a string `bin` exposes the package name;
- an object `bin` exposes only its keys;
- no `bin` exposes nothing.

Visibility is calculated per calling package, not as a monorepo-wide union. `visibleBins(unit)` contains bins from packages that `unit` declares in `dependencies` or `devDependencies` and that resolve to a workspace package, plus other package-manager-independent declared bin mappings already known to PS040. Dependency keys are not treated as proof when an `npm:` alias names another provider or a `workspace:` dependency resolves to a package without the invoked `bin`.

Root toolchain visibility is the one manager-aware exception to the conservative common contract. When exactly one non-conflicting `packageManager`/root-lockfile identity proves npm or pnpm, leaf scripts may use verified root dependency providers and real root workspace-dependency bins: npm run-script adds ancestor `node_modules/.bin` directories to `PATH`, and pnpm explicitly adds `<workspace root>/node_modules/.bin`. Yarn remains per-workspace (modern Yarn requires `-T` for root binaries and PnP explicitly keeps root `tsc` root-only); Bun and unknown or conflicting manager signals remain conservative. An undeclared sibling workspace and the calling package's own `bin` are not assumed executable. npm, pnpm, Yarn, Bun, conflict, and unknown-manager fixtures establish these boundaries, including scoped packages, aliases, and custom bin keys.

### 7.3 Recoverable multi-file write

Cross-file replacement cannot be atomic. ScriptSpect promises a detectable, recoverable compensating transaction, while each individual final replacement uses the strongest same-filesystem atomic primitive available. `--fix` follows this protocol:

1. canonicalize and preflight every target file;
2. record canonical path, file ID/inode where available, size, mtime, mode, and SHA-256;
3. calculate all edits without writing;
4. create a root transaction journal and uniquely named, exclusively created same-directory staged files and backups;
5. flush journal creation, the complete target list, and every backup digest before the first replacement;
6. revalidate canonical path and source identity immediately before each commit;
7. replace each target, flush the file and its containing directory where supported, persist and flush that commit state, and only then continue to the next file;
8. on failure, compare identity again before each compensating rollback;
9. if another process changed a committed target, do not overwrite it—retain the controlled backup and report `manual-recovery-required`;
10. clean only temporary files owned by the current transaction after verified success or verified rollback.

The terminal states are `success`, `rollback-success`, `rollback-partial`, and `manual-recovery-required`. Every non-success state exits 2 and prints the journal and backup locations; a subsequent `--fix` detects an unfinished journal and refuses new writes until recovery is resolved.

`scriptspect recover --transaction <journal>` is the sole automated recovery entry point. It is read-only unless `--apply` is supplied. It verifies journal ownership/version, canonical containment, backup digests, current file identity, and the last durably recorded transition; it then previews or completes the remaining rollback. A changed target or missing/corrupt backup yields `manual-recovery-required` with deterministic per-file instructions and never overwrites the changed file. New fixing is allowed only after a journal reaches `success` or `rollback-success`; a maintainer may archive a manual-recovery journal only through an explicit acknowledgement recorded in the journal.

Original file modes are preserved. A concurrent modification aborts rather than overwriting another process. The CLI never calls this cross-file atomic and never prints “fixed” unless post-write reanalysis proves the intended root scripts changed and the corresponding safe findings disappeared.

`--fix-dry-run` and `--fix` consume the same plan. Tests assert that applying the dry-run patch yields byte-for-byte the same manifest as `--fix` for every automatic fixer, multiple scripts, and multiple packages.

## 8. CLI semantics

The failure universe is calculated after config severity overrides and ignores but before display filtering.

- Exit 0: no error and warnings do not exceed `--max-warnings`.
- Exit 1: any error, or warnings exceed the configured budget.
- Exit 2: invalid options/config, invalid or ambiguous package manifests, root or I/O errors, recovery-required states, or an internal analyzer failure.

Every shipped default `error` rule is high-confidence. Medium-confidence rules default to warning or advisory, preserving the specification's high-confidence default CI gate. A user who explicitly overrides a medium-confidence rule to `error` intentionally promotes it into the failure universe; confidence remains visible but does not veto that explicit severity decision.

| Finding after config | Display threshold | Warning budget | Exit |
|---|---|---|---|
| high-confidence `error` | any | any | 1 |
| medium-confidence rule explicitly promoted to `error` | any | any | 1 |
| hidden `warn` | `error` | exceeded | 1 |
| hidden `warn` | `error` | not exceeded | 0 |
| `advisory` only | any | any | 0 |

`--severity` changes what is printed, not whether hidden findings fail CI. `--quiet` changes presentation only. `--no-color` accepts Cac's normalized `color: false` form and is tested at the spawned-process byte level for the absence of ANSI escapes.

JSON output is validated against `schema/output.schema.json`. Human and GitHub reporters use the same post-config findings and summary, so counts and exit behavior cannot disagree.

## 9. GitHub Action

The composite action is replaced with a bundled JavaScript action:

```yaml
runs:
  using: node24
  main: dist/action.mjs
```

`src/action.ts` uses the same analyzer modules as the CLI. Inputs are `path`, `target`, `severity`, and `max-warnings`; the current `version` input is removed because the Git ref is the Action version. Inputs are read as data and converted to an options object without shell evaluation. `target`, `severity`, and `max-warnings` use strict allowlists/ranges; `path` is resolved relative to `GITHUB_WORKSPACE` and must remain inside it. Errors never echo raw invalid inputs. The action does not enumerate or print environment values, and its outputs contain only numeric counts and validated repository-relative paths. It performs no npm install, `npx`, subprocess execution of target scripts, or network lookup.

The exact output names are `exit-code`, `packages`, `scripts`, `errors`, `warnings`, and `advisories`. Findings use GitHub workflow commands for annotations and the existing Markdown summary. The action writes annotations, summary, and all outputs before converting CLI exit 1 or 2 into `core.setFailed`; failure does not erase diagnostic evidence. Default behavior is read-only and never invokes `--fix`.

The generated `dist/action.mjs` is committed because GitHub loads it directly from the referenced tag. CI rebuilds it and fails if the committed bundle differs. A real GitHub-hosted `uses: ./` job runs against broken and clean fixtures. The broken step uses `continue-on-error: true`; later `if: always()` assertions verify outcome, outputs, annotations/summary evidence, and an unchanged fixture worktree. Release verification additionally consumes a checkout of the immutable version tag; local consumption alone is not sufficient release evidence.

Published users may reference protected `@v0.1.0`, floating `@v0.1`/`@v0`, or, for security-sensitive workflows, the full release commit SHA. Floating aliases move only after the corresponding package, Action, assets, and checksums pass verification and are documented as automatically updating. A version tag is called immutable only after a tag ruleset blocks update and deletion. `v1` is reserved for an actual 1.x release.

## 10. CI and repository protections

Pull-request workflows are read-only. Formatting, docs, schemas, bundles, lock consistency, and demo assets are checked for diffs; CI never pushes contributor code or grants `contents: write` to a job that executes pull-request content. Normal quality, matrix, package, and Action jobs declare `contents: read`; CodeQL adds only `security-events: write`; dependency review receives only its documented minimum. A policy test fails if a `pull_request` job requests `contents: write`, contains `git push`, uses a secret, or if any `pull_request_target` workflow executes contributor-controlled code.

Trust boundaries are explicit:

- `pull_request` and ordinary `push` CI execute repository code with read-only permissions and no release secrets;
- corpus collection is manual/scheduled, read-only, and never writes third-party repositories;
- release-please may update only its release PR and runs with its own serialized concurrency group. A merged release-please PR creates one queryable release intent from trusted GitHub PR metadata plus the exact commit contents: `{prNumber, mergeCommitSha, version, tag, packageManifestHash, changelogHash, releasePleaseManifestHash}`;
- the release coordinator accepts `workflow_run` only when the allowlisted CI workflow has `conclusion == success`, `event == push`, `head_branch == main`, `head_repository.full_name == github.repository`, and `head_sha == intent.mergeCommitSha`; the intent must identify exactly one merged release-please-bot PR and its commit must remain reachable from current `main`. Ordinary main pushes, ancestor SHAs, fork/PR heads, and downloaded CI artifacts are never release inputs;
- an authorized `workflow_dispatch` requires release-environment approval and the same intent ID/PR number; its version, tag, and SHA must exactly equal that intent rather than merely naming an arbitrary reachable ref;
- every coordinator path uses `concurrency: release-<version>` with cancellation disabled;
- the one-time npm bootstrap is manual, separately permissioned, and removed after trust is configured.

All installs use the committed lockfile with frozen semantics. The package-manager version is pinned through the supported setup path. A separate lock-consistency check proves that the manifest and lockfile agree without updating the branch.

Quality gates include:

- format/lint with warnings treated as failures;
- typecheck;
- parser/rule coverage with lines, statements, functions, and branches at or above 90 percent;
- unit/integration/regression corpus tests;
- generated-file parity;
- `npm pack` content and fresh-install smoke;
- `uses: ./` Action consumption;
- Linux, macOS, and Windows on Node 22 and 24;
- CodeQL and dependency review;
- 100-package workspace analysis below two seconds on a hosted runner;
- invalid-input redaction, numeric/path-only Action outputs, and no environment-value leakage.

`.gitattributes` pins repository text to LF so a Windows checkout passes the same formatter. Directory-link tests use Windows junctions where equivalent; file-symlink security cases run wherever the platform grants capability and are always enforced on POSIX hosted runners.

Runtime direct dependencies remain below ten, every third-party Action stays pinned to a full commit SHA, and Dependabot remains enabled. These are machine-checked release criteria rather than background preferences.

Branch and tag protection are maintainer-admin steps, not claims that a pull request can guarantee. After stable check names have successful recent runs, the final admin checklist records the ruleset ID and exact required check names. `main` receives required pull requests/checks plus no-force-push/no-delete protection. A single-maintainer project does not configure an impossible self-approval requirement, but review and rollback expectations remain documented.

Before the first formal release, an administrator creates and tests two tag policies: immutable `v*.*.*` tags allow the named coordinator actor to create but no actor to update/delete; floating `v0` and `v0.*` allow only that actor to create/update and to CAS-delete a newly created alias solely when a later step in that same release must roll back to a previously absent target. Every other deletion remains blocked. The checklist records ruleset IDs, bypass actor, and a non-production tag drill. If the repository `GITHUB_TOKEN` cannot satisfy these exact semantics, release remains blocked until an explicitly installed GitHub App or administrator-approved exact-SHA path is configured; the workflow never assumes a bypass. Protected version tags are called immutable only after this preflight passes.

## 11. Packaging and release recovery

### 11.1 Single release owner and state machine

`release-please` owns only the version/changelog pull request. Its configuration uses `skip-github-release: true`; it never creates a release tag or public GitHub Release. A single release coordinator owns every later transition:

1. the corrected release PR is merged;
2. ordinary `main` CI succeeds for the exact merge SHA;
3. a trusted trigger starts the coordinator, which applies the §10 intent predicates, checks out exactly `intent.mergeCommitSha`, recomputes every intent hash, reads a strict-semver version, proves `tag == v${version}`, verifies package manifest/changelog/release-please manifest agree, proves the intent is not consumed and the immutable version tag does not exist, and acquires `concurrency: release-<version>` with cancellation disabled; an existing tag enters only the explicit retry path for the same intent;
4. from that detached checkout it installs with the frozen lockfile, builds once, runs package smoke tests, creates one `.tgz`, computes SHA-256 and npm SRI, and uploads the tarball plus immutable `candidate-manifest.json` as a retained workflow artifact before creating public refs;
5. the coordinator creates the protected immutable version tag, one draft GitHub Release for that tag, attaches the exact tarball plus `SHA256SUMS`, then creates and attaches `release-manifest.json` containing the now-known Release/asset IDs and the candidate-manifest digest;
6. an independent temporary consumer checks out the immutable tag, asserts `tag^{commit}` equals the expected release SHA, and exercises the bundled Action against clean and broken fixtures before registry publication;
7. the coordinator publishes the exact draft asset tarball through npm Trusted Publishing;
8. with bounded backoff it downloads registry metadata and tarball, computes SRI, verifies public provenance, version, commit, schemas, CLI behavior, and the bootstrap-established integrity contract; timeout or inconsistency keeps the Release draft and leaves aliases unchanged;
9. it publishes the verified immutable GitHub Release;
10. it records previous alias targets, updates `v0.1` and then `v0` by compare-and-swap, and tests both consumers. Failure rolls back in reverse order on a best-effort compare-and-swap basis and leaves the DoD incomplete even though the immutable release remains valid;
11. it attaches a final verification record and marks the intent consumed. A failed run records its last durable state against the same intent so only an idempotent retry—not another version or SHA—may continue it.

`candidate-manifest.json` records the intent, version, tag, commit, package/changelog hashes, tarball name, SHA-256, npm SRI, build tool versions, and workflow run URL; it cannot contain a not-yet-created Release ID. `release-manifest.json` adds the Release ID, asset IDs/digests, and candidate-manifest digest after those objects exist. The final verification record adds registry/provenance and alias outcomes. Every mutating step compares the expected intent, SHA, release ID, and asset digest before proceeding. `v0.1.0` is never moved or deleted; only documented floating aliases are mutable.

### 11.2 Authoritative artifact and integrity contract

Once attached, the tarball in the draft Release is the authoritative artifact for initial publication and every retry. A retry downloads that asset and verifies its recorded digest; it does not rebuild and assume byte reproducibility. If the Release attachment is missing, recovery may restore it only from the still-retained coordinator artifact whose digest matches the already recorded manifest. If neither verified copy exists, recovery stops and requires a new version; it never rebuilds under the old tag. Checksums are produced and attached before npm access, so a registry outage cannot suppress release evidence.

The bootstrap run empirically determines npm's registry behavior for `npm publish <tgz>`. If the downloaded registry tarball retains exact bytes, SHA-256 and SRI must match the draft asset. If npm performs documented normalization, the release instead requires a committed, bootstrap-proven canonical comparison of the complete unpacked file set, modes, and content plus registry `dist.integrity`; no manifest file, including `package.json`, may be silently excluded from comparison. The selected contract is recorded before formal v0.1 publication and machine-checked thereafter.

### 11.3 Retry and failure recovery

The coordinator is idempotent for a version. It reuses the existing protected tag, draft release, and authoritative asset only when their recorded commit and digests match. Missing assets follow §11.2; conflicting assets or tags stop for manual recovery. npm publication is skipped only when the exact immutable version already exists and passes the same integrity/provenance checks.

Before npm success, failures leave a private draft with assets and diagnostics. After npm success, the version is immutable: recovery finishes verification and the GitHub Release from the same asset or publishes a patch and deprecates the bad version. It never retags, overwrites, or republishes an npm version. Floating aliases are serialized, advance only after all verification, and may be moved back to the last verified release if the new release is withdrawn.

The publish job runs on a GitHub-hosted runner with `id-token: write`, Node at least 22.14, npm at least 11.5.1, and no persistent registry token. It validates the actual Node/npm versions immediately before publish. Trusted Publishing supplies provenance; the workflow does not claim OIDC success until npm's public provenance is verified.

### 11.4 First npm publication

npm Trusted Publishing cannot establish ownership of a package that does not yet exist, and npm versions cannot be reused. Bootstrap therefore never consumes `0.1.0`. A separately permissioned, manually approved workflow uses a short-lived granular token from an account with the required 2FA posture:

1. recheck that `scriptspect` is available or already owned by the maintainer;
2. build and fully verify a distinct prerelease such as `0.0.0-bootstrap.0`;
3. publish that prerelease explicitly with `--tag bootstrap`, verify `latest` did not move, and use it to prove the registry integrity contract;
4. configure the exact `Tom409114/scriptspect` repository, workflow filename, and environment as the npm Trusted Publisher;
5. delete/revoke the granular token, delete the GitHub secret, and disable or remove the token-bearing workflow path;
6. publish the untouched formal `0.1.0` through the steady-state OIDC coordinator;
7. remove the `bootstrap` dist-tag when it is no longer useful, while accepting that the prerelease version remains immutable registry history.

The maintainer must supply the one-time token and configure npm ownership/Trusted Publishing; repository code cannot perform those account operations. The final DoD records package ownership, credential revocation, and formal OIDC provenance as three separate facts.

## 12. Bilingual GitHub homepage and docs

`README.md` is the English default for GitHub and npm. `README.zh-CN.md` is a complete Simplified Chinese peer. Both begin with an `English | 简体中文` switch and share the same commands, rule IDs, version references, assets, section keys, and status facts. A parity checker prevents one language from silently falling behind.

The parity checker compares stable section keys, fenced command/code blocks, URLs, version strings, rule IDs, and asset hashes. It does not require translated prose to be textually identical. Command names, config keys, rule IDs, package names, versions, paths, and copy-paste examples remain untranslated and byte-identical where their syntax is language-independent. It also proves both language switches are bidirectional, every target file/anchor/asset exists, and English-only deep documentation is visibly labeled “English documentation” on the Chinese page.

The information hierarchy follows the adoption path:

1. five-second value proposition and trustworthy badges;
2. Node requirement and 30-second local scan;
3. a real broken `package.json` before state;
4. generated CLI transcript and accessible terminal SVG;
5. `--fix-dry-run` and verified after state;
6. why ScriptSpect differs: target parser, actionable target/confidence, safe fixes;
7. complete GitHub Action workflow and local reproduction;
8. minimal config and precise suppression;
9. platform/package-manager support and honest limitations;
10. FAQ/troubleshooting;
11. rules, architecture, comparison, validation, security, contributing, roadmap, and evidence links;
12. status claims backed by clickable public evidence.

A versioned demo fixture is the single source for the package snippet, CLI text, patch, and SVG. CI regenerates all assets and fails on drift. Images include descriptive alt text and the same information remains available as selectable text.

Before npm publication, a visually separate “Evaluate from source (pre-release)” block lists the required Node version, clone and exact checkout, frozen install, build/run command, minimal fixture, and expected exit code. It does not present `npx scriptspect` as usable or mix the longer source path with the future 30-second quick start. After publication, the generated release-state manifest replaces that block with the verified public command. Status text is never hand-edited. The GitHub Action example likewise points to no nonexistent tag: pre-release docs use a checkout/local-consumer example; published docs use the verified immutable release tag and also recommend a full commit SHA for security-sensitive workflows.

The badge allowlist is deliberately small: license and green hosted-CI badges are allowed when their targets are public; npm version and GitHub Release badges appear only after the corresponding public artifacts exist. Stars, downloads, precision, adoption, “production ready,” and milestone-completion badges are prohibited unless a later evidence policy defines and verifies them.

The homepage does not claim M0–M8 completion, zero false negatives, external adoption, npm availability, a usable Action tag, performance, or comparative superiority until those facts are publicly reproducible through the linked evidence.

## 13. Corpus, evidence, and truthfulness

The corpus scanner discovers workspace manifests through the same canonical-root and workspace-boundary policy as the CLI rather than downloading only the root manifest. It excludes dependency, VCS, vendor, generated, build, and distribution directories; rejects symlink escapes; applies documented depth/file/manifest/byte limits; and reports truncation instead of silently sampling a huge tree. Root-only and full-workspace statistics remain separate so PS040 and monorepo conclusions are not inflated.

Every reproducible corpus run commits a durable manifest containing public repository URL, immutable commit, selected manifest paths, root-only/workspace-full mode, scanner version and commit, rule-registry hash, sampling seed/method, environment or container digest, finding IDs, artifact hashes, and the exact reproduction command. By default it stores locators and hashes rather than complete third-party script text, and redacts token/credential patterns before persistence. The adjudication sample is stratified across triggered rules, severity, and confidence so the most common finding cannot dominate; disputed/unclear cases do not count as true positives. Each adjudicated finding records outcome, rationale/source, reviewer, date, and a documented secondary-review sample. Expiring workflow artifacts may supplement but never replace this versioned record. At least 100 findings require human adjudication before a precision percentage is promoted. Known false positives and false negatives become versioned regression fixtures before a fix is merged.

A scripts-doctor comparison is an executable harness over the same fixture corpus with a pinned scripts-doctor version, pinned Node/container environment, captured commands and outputs, and the same human adjudication fields. Until the harness is committed and reproducible, comparison copy states the limitation instead of claiming a head-to-head win. No comparative claim ships in the homepage before this gate passes.

Monthly evidence automation runs on a documented schedule and manual trigger, reads public GitHub/npm APIs, records source timestamps and response hashes, and produces an uncommitted draft artifact. A failed or partial query fails the run rather than writing zeroes. The named maintainer reviews and approves any `docs/evidence/YYYY-MM.md` update within the documented review window; an overdue or unreviewed draft leaves every adoption gate `OPEN` rather than implying zero or success.

## 14. Testing strategy

Development follows red-green-refactor. Each confirmed bug begins with a failing regression that exercises the public or nearest stable contract.

Required matrices include:

- per-target quotes, escapes, operators, redirections, variables, groups, wrappers, and malformed syntax;
- all v0.1 rules with declarative `{caseId, ruleId, polarity, targets}` fixture metadata and at least three positive and three negative cases counted by CI;
- every automatic fixer with declarative fixer metadata and safe, missing-dependency, no-change, dry-run parity, idempotency, span-disagreement, and parser-diagnostic cases;
- nested `scripts`, duplicate keys, CRLF/LF, Unicode, BOM, invalid JSON, concurrent file changes, journal crash points, recovery preview/apply, post-crash changes, and missing/corrupt backups;
- config/schema valid-invalid parity and all root/symlink escape paths;
- workspace `bin` absent/string/object/scoped cases across npm, pnpm, Yarn, and Bun fixtures;
- display-filter/exit-code combinations and byte-level no-color behavior;
- clean/broken local and GitHub-hosted Action consumers, malicious inputs, outputs, annotations, summary, and unchanged files;
- release state-machine fault injection before/after tag, draft, asset, npm, alias, and publish transitions;
- tarball contents, schemas, bundled Action, fresh install, provenance, checksums, authoritative-asset retry, and recovery.

Completion claims require fresh command output. A passing narrow test cannot stand in for a cross-platform, package, Action, or release requirement.

## 15. Rollout and rollback

- Core changes land before Action or release changes; no public tag references an unverified parser or fixer.
- Generated artifacts are reviewed through source inputs and reproducibility checks.
- `release-please` creates only the release PR; the serialized coordinator alone creates the protected tag and draft Release.
- Floating tags move only after immutable release verification and can be moved back to the last verified commit if a release is withdrawn.
- npm versions are immutable; a bad publication is deprecated and replaced by a patch release, never overwritten.
- Existing config keys and rule IDs remain stable. The new PS051, stricter ignore validation, and any corrected rule semantics are documented in the changelog, rule reference, config/output schemas, and compatibility notes before release.
- The distinct bootstrap prerelease validates registry behavior without consuming `0.1.0`; the token path is removed before the formal coordinator is enabled.
- Operational gates that code cannot create—external interest, downstream adoption, and time-based KPIs—remain visibly open in the final DoD report.

## 16. Acceptance boundary

Acceptance is reported in three layers so repository readiness is not confused with a completed public release or later adoption.

### 16.1 Repository-controlled release readiness

1. npm name availability/current ownership has been rechecked; any unresolved maintainer-admin ownership action remains explicitly `OPEN` and blocks §16.2 rather than being called repository-controlled work.
2. The release-candidate DoD links a dated, commit-pinned P0 ledger snapshot. Every item in that snapshot is red-then-green; a P0 discovered before publication is added to the snapshot and blocks release. Declarative matrices prove per-target rule truth and fixer gates.
3. The exact candidate commit passes Linux, macOS, and Windows on Node 22/24, coverage, security, dependency, frozen-lockfile, generated-file, package, hosted Action, 100-package performance, invalid-input redaction, and environment non-disclosure checks.
4. Packed schemas, CLI, bundled Action, demo assets, English/Chinese README parity, comparison harness, and durable corpus evidence are generated or reproducible from that commit.
5. Release workflows pass policy and state-machine tests; all third-party Actions are SHA-pinned, runtime dependencies remain below ten, and the admin preflight records stable required checks, branch/tag ruleset IDs, coordinator actor, and a tag-permission drill.
6. The requirement ledger links evidence for every repository-controlled closed gate and clearly labels administrator and external steps.

### 16.2 Published v0.1 verification

1. Package ownership and the exact Trusted Publisher tuple exist, the bootstrap integrity contract is recorded, and the one-time credential/secret/workflow path has been revoked or removed.
2. The protected release commit and immutable `v0.1.0` tag pass all hosted checks.
3. The authoritative Release asset, `SHA256SUMS`, manifest, registry package, npm integrity/provenance, packaged schemas, and installed CLI satisfy the recorded artifact contract.
4. GitHub-hosted consumers successfully exercise `@v0.1.0`, then the serialized coordinator advances and verifies `@v0.1` and `@v0`.
5. The GitHub Release is public, both README languages expose only verified install/Action commands and allowed badges, and the final DoD report cites public workflow/release/npm evidence.

### 16.3 Adoption readiness remains open

External issues, independent onboarding, stars, downstream repositories, user feedback, and time-based KPIs are not release artifacts and remain `OPEN` until authentic third-party evidence exists. Monthly evidence drafts do not close those gates without human review and a durable public source.

This design does not redefine external adoption as a code deliverable. It makes the project ready to earn adoption and makes every future claim auditable.

## 17. Primary references

- [GitHub Actions metadata syntax (`node24`)](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [release-please Action behavior and outputs](https://github.com/googleapis/release-please-action)
- [release-please configuration schema](https://github.com/googleapis/release-please/blob/main/schemas/config.json)
- [GitHub repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [GitHub secure workflow guidance](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
- [`npm trust` ownership prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [`npm publish` version and dist-tag behavior](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
