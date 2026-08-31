# Evidence policy

Public product claims must be reproducible from durable sources. Automation may
create a draft; it cannot approve its own metrics.

## Current status

The repository has a scheduled/manual, read-only corpus draft workflow. A
broader monthly adoption/community scorecard is still **OPEN** and must not be
described as implemented until its API collector, tests, and reviewed first run
exist. Missing data is never converted to zero.

## Monthly review contract

Future `docs/evidence/YYYY-MM.md` ledgers may track:

- adoption: public downstream CLI/Action usage and repeat use;
- community: external issues, contributors, reviews, and response time;
- maintenance: releases, triage, regressions, and rule changes;
- quality: hosted CI, coverage, and reviewed false-positive/negative data;
- impact: public portability bugs confirmed or fixed;
- AI leverage: reviewed AI-assisted work, including rejected suggestions.

Each value needs its source URL or immutable response hash, collection time,
query/method, completeness status, and reviewer. `Tom409114` (or a documented
delegate) reviews a draft within seven calendar days. An unreviewed or overdue
draft remains an artifact and every affected gate stays `OPEN`.

## Non-negotiable rules

- no fabricated, purchased, exchanged, or inferred adoption;
- no automated third-party issues, pull requests, comments, or outreach;
- no precision, benchmark, comparison, download, or adoption claim from an
  unreviewed/partial query;
- no secret, raw third-party script source, or environment dump in evidence;
- corrections remain visible and identify the superseded claim.

See the [corpus methodology](corpus-method.md) for finding-level evidence.

