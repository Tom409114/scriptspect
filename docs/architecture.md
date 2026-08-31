# Architecture

## Pipeline

```text
raw script string
   ↓
lexical scanner (quote / escape / operator aware)
   ↓
token stream
   ↓
command IR (sequence / pipeline / command / env assignment / redirection / shell wrapper)
   ↓
rule engine
   ↓
findings + safe-fix candidates
   ↓
reporter (stylish / json / github)
```

The core is a deterministic, offline **lexical/structural analyzer** — not a full shell interpreter, and not regex stacking.

## IR (TypeScript)

```ts
type ShellTarget = 'posix-sh' | 'cmd' | 'powershell';

type CommandNode = {
  kind: 'command';
  raw: string;
  span: [number, number];
  argv: Token[];
  leadingEnv: EnvAssignment[];
  wrapper?: { shell: ShellTarget | 'bash' | 'sh'; raw: string };
};

type Finding = {
  ruleId: string;
  scriptName: string;
  packagePath: string;
  span: [number, number];
  severity: 'error' | 'warn' | 'advisory';
  confidence: 'high' | 'medium';
  affectedTargets: ShellTarget[];
  message: string;
  fix?: FixCandidate;
};
```

## Parser contract — negative cases that must always hold

| Input | Requirement |
| --- | --- |
| `echo "rm -rf dist"` | never treat `rm` inside a string as a command |
| `node -e "console.log('cp -r')"` | never scan inside string arguments |
| `cross-env NODE_ENV=production vite build` | no POSIX env-assignment finding (already cross-env) |
| `shx rm -rf dist` | no native-rm finding (already shx) |
| `rimraf dist` | no rm finding |
| `bash -c "rm -rf dist"` | explicit bash dependency finding; do not re-report inner tokens |
| `echo foo && echo bar` | `&&` is fine on both sh and cmd — no finding |
| `echo "a && b"` | never split quoted operators |
| `cmd /c "set FOO=bar&& node app.js"` | recognized as explicit cmd wrapper |
| `powershell -NoProfile -Command "$env:FOO='bar'; node app.js"` | recognized as explicit powershell wrapper |

These cases are enforced as fixtures in `tests/parser/`; a parser change that breaks any of them cannot merge.

## Rules

Rules are standalone modules (`src/rules/PSxxx.ts`) exporting typed metadata plus a `check(context)`. Metadata is the single source of truth for `docs/rules/*` and the `explain` command. Rule IDs are public API once released; semantic changes are noted in release notes.

## Fix engine

Fixes carry a safety class:

- `safe` — no new dependencies, provably equivalent locally; auto-applied by `--fix`
- `conditional` — needs e.g. a devDependency or a verified precondition; planned, applied only when preconditions are verified
- `manual` — explained, never applied

All fixers are idempotent and preserve package.json formatting (indentation, line endings, field order).

Multi-manifest writes use a compensating transaction. Every source is preflighted by canonical path, inode/file ID, link count, mode, mtime, size, and SHA-256. Backups and replacement bytes are flushed before installation. Installation first moves the exact old target to a unique hold, verifies what was moved, then creates the new target with an exclusive hard link; it never renames a stage over an occupied pathname. A concurrent replacement is preserved and produces `manual-recovery-required` rather than being overwritten. Original files with multiple hard links are rejected because replacing one pathname would silently change link topology.

The CLI keeps backups and holds through post-fix analysis. Only a verified after-state finalizes and removes transaction state; analyzer or semantic verification failure rolls the installed files back first. Ordinary `success` and `rollback-success` records are removed so `--fix` does not leave repository dirt. Manual evidence remains until `scriptspect recover --transaction … --apply --acknowledge-manual` records the maintainer decision. That command also provides the sole explicit inspection/acknowledgement path for an orphan lock or unreadable owned journal, and it never infers or deletes unknown auxiliary files.

Transaction metadata protects against accidents, crashes, cooperative concurrent editors, path escapes, and hard-link substitution. It is not an authentication boundary against another process running as the same operating-system user: such a process can already rewrite both the project and its metadata. Recovery therefore treats same-user journal authenticity as a documented local trust boundary while still requiring exact identities and explicit acknowledgement for unreadable state.

## Config

JSON config (a `scriptspect` field in package.json or `scriptspect.config.json`) with a published JSON Schema: `targets`, per-rule severity overrides, and `ignore` entries (package globs × script globs × rule IDs). No DSL.

## Workspaces

Root package.json `workspaces` (array or `{ packages: [] }` form) plus `pnpm-workspace.yaml` globs. `node_modules`, vendor/build dirs, duplicate paths, and symlink loops are excluded; findings carry relative package paths.
