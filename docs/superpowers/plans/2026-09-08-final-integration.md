# Final integration implementation plan

**Goal:** Integrate useful outstanding branches into GitHub main, publish an accurate bilingual homepage, then delete superseded branches.

**Architecture:** Port PR #82 by independently tested runtime and evidence-tooling bundles. Preserve the working 0.1.2 release chain and immutable tags. The homepage links the verified published package, while main may contain next-release fixes.

**Tech stack:** TypeScript, Vitest, pnpm 11.24.0, GitHub Actions.

**Scope:** User-approved final cleanup; no new product features or unsolicited external promotion.

- [ ] Runtime: port parser/rule/workspace regression tests before their fixes from PR #82; run targeted tests; add semver and rebuild the Action bundle.
- [ ] Evidence tools: port corpus, monthly evidence and comparison tests before implementation; preserve historical evidence labels; run targeted tests.
- [ ] Dependencies: consolidate the exact patch updates from PRs #85–87; frozen-lockfile install and lint/typecheck.
- [ ] Presentation: render verified 0.1.2 release state; maintain bilingual command/link parity, real demo, current security policy and launch drafts. Keep unreleased main changes distinct from the published version.
- [ ] Integration: run build, full tests, lint, typecheck, README parity and live release-evidence verification; independently review the diff.
- [ ] Delivery: push reviewed changes, wait for CI, merge to main, close superseded PRs and delete their remote/local branches. Keep recoverable Git bundle backup and immutable release tags.

Existing work is preserved. No old release workflow or zero-version metadata from PR #82 may replace current main. No claim of adoption, external feedback, rendered video, or completed historical research gates without real evidence.
