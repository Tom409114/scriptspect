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

Each source receipt records the request start and completion times, source URL
and query, completeness, HTTP status, exact raw-response SHA-256 and byte
length, and a structural summary. The raw response bodies are not persisted.
Only the fixed APIs' expected HTTP 200 response is complete; another 2xx status
remains partial. Every request has a 30-second timeout, and
the collector has an eight-minute global deadline inside the workflow's
15-minute job timeout so a partial draft can still be written and uploaded.
GitHub list endpoints are followed page by page, with at most 1,000 pages per
source. Off-origin or non-sequential next-page metadata, conflicting Actions
`Link`/`total_count` metadata, a duplicate immutable issue, release, or
workflow-run ID, a failed page, invalid JSON, structurally invalid 2xx JSON, or a
transport/API error makes the affected source `partial` and leaves its metrics
`null`, not zero. The workflow job fails after the draft is written for the
`always()` artifact upload.

For a multi-page source, `response.pageSha256` persists the ordered page-body
hash manifest (bounded to 1,000 entries). The combined `response.sha256` is the
SHA-256 of the UTF-8 manifest `1:<page-1-sha256>\n2:<page-2-sha256>...`; a
single-page source keeps its page-body SHA-256 directly. This makes the combined
receipt independently recomputable without persisting any response body.

Before the first npm publication, paired 404 responses from the registry and
downloads endpoints are an expected unavailable state only when both bodies are
readable JSON error objects with complete hash receipts **and** the complete
public GitHub release count is observed as exactly zero. They remain explicit
`missing`/`null` warnings and keep generation `partial`, but do not make the
monthly workflow red. Once a public GitHub release exists, or when its count is
not complete, npm absence is blocking. A one-sided or malformed npm 404, a
GitHub 404, any other npm error, or any real network/API failure still fails the
job.

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
