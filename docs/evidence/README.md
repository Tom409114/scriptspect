# Evidence policy

Public product claims must be reproducible from durable sources. Automation may
create a draft; it cannot approve its own metrics.

## Current status

The repository has two read-only draft paths: the corpus workflow described in
[`corpus-method.md`](corpus-method.md), and the monthly public-API collector in
[`.github/workflows/monthly-evidence.yml`](../../.github/workflows/monthly-evidence.yml).
The latter runs monthly and through `workflow_dispatch`. It never commits or
opens an issue/PR; it only uploads a 30-day workflow artifact for review.

The artifact contains JSON conforming to
[`docs/evidence/monthly-draft.schema.json`](monthly-draft.schema.json) plus a
reviewer-facing Markdown rendering. Both are explicitly `unreviewed`. The
collector capability is implemented, but its first real metrics, human review,
and all external/time-dependent M8 gates remain **OPEN**.

## Collector boundary

The collector reads the public GitHub repository, issues, releases, and CI-runs
APIs plus the public npm package and last-month downloads APIs. A GitHub token is
sent only as an authorization header to GitHub. It is not accepted as a CLI
argument and is not written to either artifact.

Each source receipt records collection time, source URL and query, completeness,
HTTP status, response SHA-256, byte length, and a structural summary. The raw
response bodies are not persisted. A `Link: rel="next"`, an Actions
`total_count` larger than the returned page, a 404, invalid JSON, or a transport
failure makes the affected source `partial` or `missing`. Affected metric values
remain `null`, not zero, and the overall generation is marked `partial`. The
draft is still written for the `always()` artifact upload, but the workflow job fails
so incomplete collection cannot look like a successful monthly run.

## Monthly review contract

Generated ledgers contain six review placeholders:

- adoption: public downstream CLI/Action usage and repeat use;
- community: external issues, contributors, reviews, and response time;
- maintenance: releases, triage, regressions, and rule changes;
- quality: hosted CI, coverage, and reviewed false-positive/negative data;
- impact: public portability bugs confirmed or fixed;
- AI leverage: reviewed AI-assisted work, including rejected suggestions.

Each publishable value needs its source URL or immutable response hash,
collection time, query/method, completeness status, and reviewer. `Tom409114`
(or a documented delegate) reviews a draft within seven calendar days. An
unreviewed or overdue draft remains an artifact and every affected gate stays
`OPEN`. Automation cannot fill reviewer identity, review timestamps, downstream
usage, false-positive adjudication, impact, or AI-leverage evidence.

## Non-negotiable rules

- no fabricated, purchased, exchanged, or inferred adoption;
- no automated third-party issues, pull requests, comments, or outreach;
- no precision, benchmark, comparison, download, or adoption claim from an
  unreviewed/partial query;
- no secret, raw third-party script source, or environment dump in evidence;
- corrections remain visible and identify the superseded claim.

See the [corpus methodology](corpus-method.md) for finding-level evidence.
