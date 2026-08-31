# Corpus validation methodology (M8)

How scriptspect validates precision against real public code — reproducible and
free of hand-entered numbers (spec §16, §20).

## Scan

1. `corpus.yml` (manual dispatch) samples popular public JS/TS repositories
   via the GitHub search API and records the list in `repos.txt`.
2. `tools/corpus-scan.ts` fetches each repo's `package.json` read-only and
   runs the full rule engine over its scripts with default targets
   (`posix-sh`, `cmd`).
3. Outputs (uploaded as the `corpus-draft` artifact, never auto-committed):
   - `findings.jsonl` — one line per finding (repo, script, rule, message,
     source) for traceable verification
   - `summary.md` — counts per rule/repo

## Precision sampling (human gate)

- Sample findings uniformly (≥100) and verify each against the repo's real
  scripts: would this command actually fail on a default Windows npm setup?
- Precision = verified / sampled, reported overall and per rule.
- Every false positive becomes a regression fixture in `tests/rules/` before
  the rule is adjusted (spec §11.2 golden corpus).

## Publication rules

- Only human-verified numbers may appear in `docs/evidence/`.
- Draft outputs stay as CI artifacts; unverified data is never committed.
- Scanning is strictly read-only: no issues, PRs, or comments on third-party
  repositories without explicit authorization (spec §0 COMMUNITY-02).

## Kill-or-commit thresholds (spec §16)

| Gate | Continue if | Otherwise |
| --- | --- | --- |
| Overall precision | ≥85% sampled (P0 high-confidence rules ≥95%) | <80%: stop adding rules, fix parser/context |
| Real-problem density | ≥20 confirmed issues in ≥10 projects, ≥4 rule classes | re-evaluate scope |
| Competitive edge | finds real issues scripts-doctor misses, without more FPs | don't publish; improve |
