# Contributing rules

Every detection in scriptspect is a rule module with machine-checked metadata. This guide walks through adding one.

## 1. Pick the pattern and prove the behavior

A rule starts with a portability claim, e.g. "`rm` is not available in native Windows npm scripts". Evidence can be:

- official shell documentation (POSIX spec, Microsoft cmd/PowerShell docs)
- man pages
- a public project where this exact script failed on another OS

AI opinions are not evidence (see [AI_USAGE.md](../AI_USAGE.md)).

## 2. Create the rule module

Copy an existing rule (`src/rules/PS010.ts`) and fill in the metadata:

```ts
export const rule: RuleModule = {
  id: 'PS0XX',
  title: 'SHORT_TITLE',
  summary: 'one sentence a user can act on',
  severity: 'error' | 'warn' | 'advisory',
  confidence: 'high' | 'medium',
  affectedTargets: ['cmd'],
  badExamples: ['rm -rf dist', 'rm -r build'],
  goodExamples: ['rimraf dist', 'shx rm -rf dist'],
  falsePositiveNotes: 'what must never be reported and why',
  fixSafety: 'safe' | 'conditional' | 'manual',
  provenance: [{ source: 'https://…', claim: '…' }],
  check(ctx) { … }
};
```

All fields are required. `badExamples` and `goodExamples` need at least 2 entries each.

## 3. Fixtures: 3 positive + 3 negative minimum

Add `tests/rules/PS0XX.test.ts` with at least:

- 3 positive cases — inputs that MUST produce the finding
- 3 negative cases — inputs that MUST NOT (quote-context and already-fixed cases especially)

A rule without negative fixtures cannot merge.

## 4. If the rule has a fixer

- Classify it: `safe` (no new deps, provably equivalent), `conditional` (requires a dependency or precondition), or `manual`
- Test idempotency: applying twice must not double-wrap (`cross-env cross-env …` is a bug)
- Test the "dependency missing" path: no half-fixed states, no silent installs, no lockfile edits
- Preserve package.json formatting (indentation, line endings, field order)

## 5. Docs and registration

- `docs/rules/PS0XX.md` must render from the rule metadata (run the docs check)
- Register the rule in `src/rules/index.ts`
- Update the README support matrix if the rule adds a capability

## 6. Open the PR

The PR template asks for rule semantics changes — describe exactly what new/changed findings users will see. A maintainer reviews; CI must be green on Linux, Windows, and macOS.
