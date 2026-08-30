# Contributing to scriptspect

Thanks for helping make package scripts work everywhere.

## Ways to contribute

- Fix a false positive or false negative (best first contribution — every one becomes a regression fixture)
- Propose a rule (use the "Rule proposal" issue template; see [docs/contributing-rules.md](docs/contributing-rules.md))
- Improve docs, especially rule provenance
- Report a real-world cross-platform script failure

## Development environments

You can contribute fully in the cloud — no local toolchain required.

### GitHub Codespaces

1. Open the repo → green **Code** button → **Codespaces** → create a codespace.
2. `pnpm install && pnpm test`
3. Create a branch, commit, push, open a PR — CI validates on all three OSes.

### GitHub web / API workflow

1. Create a branch in the GitHub UI.
2. Edit files in the web editor (or via the API).
3. Open a PR; CI runs typecheck, lint, tests (ubuntu/windows/macos × node 22/24), packaging smoke, and CodeQL.

### Locally (optional)

- Node.js 22+, pnpm 11+ (`npm install -g pnpm@11` or `corepack enable`)
- `pnpm install`
- `pnpm test` — unit, fixture, and integration tests
- `pnpm typecheck && pnpm lint && pnpm build`

## Pull requests

- Small, reviewable PRs (target under 800 non-generated lines; split otherwise)
- Every PR answers the template: summary, why, rule semantics changed?, test evidence, risk and rollback
- CI must pass: typecheck, lint, tests on ubuntu/windows/macos × node 22/24, package smoke, CodeQL
- Parser/rule/fixer changes keep a human review gate — no auto-merge

## Rule contribution checklist

1. Read [docs/architecture.md](docs/architecture.md) and an existing rule module (`src/rules/PS010.ts`)
2. Rule metadata is mandatory: ruleId, title, summary, severity, confidence, affectedTargets, at least 2 bad + 2 good examples, falsePositiveNotes, fixSafety, provenance
3. Fixtures: at least 3 positive + 3 negative in `tests/rules/`
4. Fixers must be idempotent and ship a "must not modify" test
5. Docs page `docs/rules/PSxxx.md` must render from the rule metadata
6. Never execute target scripts; never require lockfile changes

See [docs/contributing-rules.md](docs/contributing-rules.md) for the full walkthrough.

## Bug fixes start with a fixture

Any bug fix must land with a regression fixture that failed before the fix — no exceptions. This keeps the false-positive rate honest over time.

## Security

Report vulnerabilities per [SECURITY.md](SECURITY.md) — never in a public issue.
