# Roadmap and milestones

Built milestone by milestone; each merges behind a PR with CI green on all three OSes.

| Milestone | Theme | Key deliverables | Exit condition |
| --- | --- | --- | --- |
| M0 | Remote repo and competitive baseline | GitHub repo, license, CI skeleton, issue/PR templates, scripts-doctor parity checklist, name-availability gate | main is buildable by Actions; zero project files on any local machine |
| M1 | Parser / IR | quote/escape/operator-aware lexer + IR; 10 key negative-case fixtures | parser tests green; quoted operators never mis-split |
| M2 | P0 portability rules | PS001/010/011/012/013/020/021/022/030/040 + the full v0.1 rule set | at least 50 deterministic tests; sampled false-positive rate acceptable |
| M3 | Reporter + explain | stylish/json/github reporters; rule docs; `explain` command | one command yields actionable findings; JSON schema frozen |
| M4 | Safe fixer | fix safety model, dry-run, cross-env/rimraf/shx conditional fixes | idempotency tests green; no half-fixed states |
| M5 | Workspaces | npm/pnpm/Yarn/Bun discovery; PS040 workspace-bin awareness | real monorepo fixtures; 100 packages scanned in under 2 seconds |
| M6 | GitHub Action | Action + annotations + job summary; 3-OS matrix | external repo runs with `uses: …@v1` |
| M7 | Release | npm trusted publishing, provenance, release notes, checksums | tag → npm entirely via GitHub Actions, no local tokens |
| M8 | Validation and real corpus | scan public OSS, human-verified sampling, false-positive ledger, public validation report | two-week kill-or-commit gate before expanding rules |

## v0.1 validation gates (kill-or-commit)

| Gate | Continue if | Otherwise |
| --- | --- | --- |
| Precision | at least 85% on a human-verified sample (P0 high-confidence rules target 95%) | below 80%: stop adding rules; fix the parser/context model first |
| Real-problem density | at least 20 confirmed issues across at least 10 independent public projects, 4+ rule categories | only rm-rf-style repeats: re-evaluate scope |
| Competitive edge | finds real issues scripts-doctor misses on the same corpus, without more false positives | no clear edge: do not publish; improve parser/CI/monorepo |
| External interest | at least 5 independent developers try the alpha, or 3+ non-acquaintance issues | none: pause features, re-validate demand |
| Onboarding | first scan in under 10 minutes from the README (ideal: under 2) | fix the experience first |
