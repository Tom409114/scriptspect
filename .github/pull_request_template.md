## Summary

<!-- What changes, in 2-4 sentences. -->

## Why

<!-- The problem or milestone this addresses. Link the issue: Fixes #NNN -->

## Rule semantics changed?

<!-- If any rule changes behavior (new findings, fewer findings, different message/fix), describe exactly
what changes and why existing users may see different output. Write "No change" if not applicable. -->

## Test evidence

<!-- What tests were added/updated. All CI checks must pass before review. -->

## Risk and rollback

<!-- What could break; how to revert. -->

## Checklist

- [ ] Tests added/updated (rules need at least 3 positive + 3 negative fixtures)
- [ ] Docs updated (docs/rules/*; README samples match actual output)
- [ ] No new runtime dependency without justification (budget: fewer than 10 direct deps)
- [ ] No execution of analyzed scripts; no telemetry
- [ ] Third-party actions/dependencies pinned to SHAs and reviewed
