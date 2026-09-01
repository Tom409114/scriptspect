# Roadmap and milestones

The links below record when each implementation slice first landed. A merged
slice is not the same as satisfying its exit condition: release, hosted-CI,
corpus, and adoption gates stay open until their public evidence exists.

The latest implementation candidate is draft [PR
#82](https://github.com/Tom409114/scriptspect/pull/82) at exact source commit
`b514d367b9922b1180e1b1efa500ff22bd014902`. Its full [PR CI run
`33501069632`](https://github.com/Tom409114/scriptspect/actions/runs/33501069632)
and [release-readiness run
`33501069825`](https://github.com/Tom409114/scriptspect/actions/runs/33501069825)
both completed successfully. The candidate is not yet `main`, and the separate
[v0.1.0 release PR #66](https://github.com/Tom409114/scriptspect/pull/66)
remains unmerged while npm ownership and Trusted Publishing are unfinished.
Repository tag permissions are now configured and fail closed; the [DoD
ledger](validation/v0.1-dod-2026-09-01.md) records the exact rulesets and the
remaining publication and external/time evidence gates.

| Milestone | Theme | Key deliverables | Exit condition | Status |
| --- | --- | --- | --- | --- |
| M0 | Remote repo and competitive baseline | GitHub repo, license, CI skeleton, issue/PR templates, scripts-doctor parity checklist, name-availability gate | `main` is buildable by hosted Actions and repository controls are recorded | implementation, hosted CI, and main controls verified |
| M1 | Parser / IR | target-aware lexer, parse matrix, exact spans, negative fixtures | parser matrix and scoped coverage gates pass on all supported OS/Node combinations | implementation and hosted matrix verified |
| M2 | P0 portability rules | PS001/010/011/012/013/020/021/022/030/040 + the full v0.1 rule set | deterministic positive/negative fixtures and reviewed precision evidence | implementation and final matrix verified; ≥100 precision gate remains M8-open |
| M3 | Reporter + explain | stylish/json/github reporters; rule docs; `explain` command | one command yields actionable findings; published JSON schemas are frozen | schemas/package contents verified; public npm publication pending |
| M4 | Safe fixer | fix safety model, dry-run, cross-env/rimraf/shx conditional fixes | idempotency, concurrency, rollback, and recovery tests pass | recovery and race suites verified on hosted matrix |
| M5 | Workspaces | npm/pnpm/Yarn/Bun discovery; PS040 workspace-bin awareness | real manager fixtures and a hosted 100-package benchmark under 2 seconds | manager fixtures and hosted 100-package benchmark verified |
| M6 | GitHub Action | bundled Node Action + annotations + job summary; 3-OS matrix | immutable released reference runs in an external repository | bundled consumer, annotations, and 3-OS matrix verified; released reference pending |
| M7 | Release | npm trusted publishing, provenance, release notes, checksums | one immutable tarball reaches npm and GitHub Release through Actions | workflow/recovery contracts, exact candidate CI/readiness, semantic/floating tag controls, and recovery key isolation verified; npm ownership/OIDC and the first public release remain pending |
| M8 | Validation and real corpus | read-only public scan, human sampling, false-positive ledger, public validation report | two-week gate, at least 100 reviewed findings, shared-corpus comparison, and real interest evidence | partial: the historical first report landed in PR #64; the reviewed fixed shared-corpus comparison is complete and a hosted 500-repository collection succeeded, while ≥100 public-corpus adjudication and external/time gates remain open |

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

### Current candidate evidence — 2026-09-01

| Gate or contract | Status | Evidence |
| --- | --- | --- |
| Candidate CI | hosted pass, PR open | Draft PR #82 source `b514d367b9922b1180e1b1efa500ff22bd014902` passed exact [CI run `33501069632`](https://github.com/Tom409114/scriptspect/actions/runs/33501069632) and [release-readiness run `33501069825`](https://github.com/Tom409114/scriptspect/actions/runs/33501069825) |
| Competitive edge | reviewed fixed-corpus evidence complete | The [versioned comparison review](comparison.md#reviewed-shared-fixture-result), run on Node `22.23.2` at the exact candidate source, judged ScriptSpect correct on 7/7 questions; `scripts-doctor@1.0.0` had 2 correct, 2 false positives, and 3 false negatives, with 14/14 independent secondary decisions agreeing |
| Public-corpus collection | hosted pass, adjudication open | The read-only 500-repository [run `33501028186`](https://github.com/Tom409114/scriptspect/actions/runs/33501028186) completed successfully; its artifact is still a draft until at least 100 findings receive the required primary and secondary human review |
| Monthly evidence | artifact produced, review open | [Run `33501032020`](https://github.com/Tom409114/scriptspect/actions/runs/33501032020) completed successfully. Its draft is intentionally partial only for npm package/download observations: both returned 404 while the complete GitHub Releases observation found 0 public releases |
| External interest and onboarding | time/user evidence open | No publication, independent adoption, or onboarding result is inferred from repository-controlled runs |
