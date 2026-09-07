# Roadmap and milestones

The links below record when each implementation slice first landed. A merged
slice is not the same as satisfying its exit condition: release, hosted-CI,
corpus, and adoption gates stay open until their public evidence exists.

Current release: [npm 0.1.2](https://www.npmjs.com/package/scriptspect/v/0.1.2)
and [GitHub Release v0.1.2](https://github.com/Tom409114/scriptspect/releases/tag/v0.1.2),
source `6f439bb974b297d5a334cebe989b4b50d7483677`.
[Finalization run 34140851653](https://github.com/Tom409114/scriptspect/actions/runs/34140851653)
verified registry bytes, signatures/provenance, release assets and Action aliases.
The [machine-checked receipt](validation/releases/v0.1.2/readme-release-receipt.json)
records the public release. The September 1 validation ledgers below are historical
snapshots, not the current publication state. Changes on `main` after this release
are next-release work; they do not alter the published tarball or immutable tag.

| Milestone | Theme | Key deliverables | Exit condition | Status |
| --- | --- | --- | --- | --- |
| M0 | Remote repo and competitive baseline | GitHub repo, license, CI skeleton, issue/PR templates, scripts-doctor parity checklist, name-availability gate | `main` is buildable by hosted Actions and repository controls are recorded | implementation, hosted CI, and main controls verified |
| M1 | Parser / IR | target-aware lexer, parse matrix, exact spans, negative fixtures | parser matrix and scoped coverage gates pass on all supported OS/Node combinations | implementation and hosted matrix verified |
| M2 | P0 portability rules | PS001/010/011/012/013/020/021/022/030/040 + the full v0.1 rule set | deterministic positive/negative fixtures and reviewed precision evidence | implementation and final matrix verified; ≥100 precision gate remains M8-open |
| M3 | Reporter + explain | stylish/json/github reporters; rule docs; `explain` command | one command yields actionable findings; published JSON schemas are frozen | schemas/package contents published in 0.1.2 |
| M4 | Safe fixer | fix safety model, dry-run, cross-env/rimraf/shx conditional fixes | idempotency, concurrency, rollback, and recovery tests pass | recovery and race suites verified on hosted matrix |
| M5 | Workspaces | npm/pnpm/Yarn/Bun discovery; PS040 workspace-bin awareness | real manager fixtures and a hosted 100-package benchmark under 2 seconds | manager fixtures and hosted 100-package benchmark verified |
| M6 | GitHub Action | bundled Node Action + annotations + job summary; 3-OS matrix | immutable released reference runs in an external repository | bundled consumer, annotations, and 3-OS matrix verified; v0.1.2 reference published; independent external-repository trial pending |
| M7 | Release | npm trusted publishing, provenance, release notes, checksums | one immutable tarball reaches npm and GitHub Release through Actions | 0.1.2 published and verified; bounded manual finalization used after the legacy provenance audit failed; receipt linked above |
| M8 | Validation and real corpus | read-only public scan, human sampling, false-positive ledger, public validation report | two-week gate, at least 100 reviewed findings, shared-corpus comparison, and real interest evidence | partial: the historical first report landed in PR #64; source tooling now supports 1–1,000 repositories and unreviewed monthly API drafts, while the last hosted run sampled 100 and human/external/time gates remain open |

## v0.1 validation gates (kill-or-commit)

| Gate | Continue if | Otherwise |
| --- | --- | --- |
| Precision | at least 85% on a human-verified sample (P0 high-confidence rules target 95%) | below 80%: stop adding rules; fix the parser/context model first |
| Real-problem density | at least 20 confirmed issues across at least 10 independent public projects, 4+ rule categories | only rm-rf-style repeats: re-evaluate scope |
| Competitive edge | finds real issues scripts-doctor misses on the same corpus, without more false positives | no clear edge: do not publish; improve parser/CI/monorepo |
| External interest | at least 5 independent developers try the alpha, or 3+ non-acquaintance issues | none: pause features, re-validate demand |
| Onboarding | first scan in under 10 minutes from the README (ideal: under 2) | fix the experience first |

### Gate status — first corpus run, 2026-08-31

| Gate | Status | Evidence |
| --- | --- | --- |
| Precision | ⚠️ promising, sample incomplete | 62/62 verified true positives in a stratified 14-rule sample; the ≥100 review gate is not met |
| Real-problem density | ⚠️ historical signal + hosted draft | The superseded root-only report remains historical only; the later hosted 100-repository workspace-full artifact is still an unreviewed draft and has not been promoted into a maintainer-reviewed public report |
| Competitive edge | ⏳ pending | the pinned owned-fixture harness has captured both tools' outputs; human adjudication and public shared-corpus evidence are still pending |
| External interest | ⏳ not yet met | 0 external issues as of 2026-08-31 (pre-release) |
| Onboarding | ⏳ pending | requires the v0.1 npm publish |

Full report: [docs/validation/corpus-2026-08.md](validation/corpus-2026-08.md).
