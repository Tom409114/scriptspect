# Corpus validation methodology

This is the reproducible, read-only process used to test scriptspect against
public code. A machine scan produces a **data draft**, not a precision claim.

## Immutable scan

1. The manual/monthly corpus workflow selects public JavaScript and TypeScript
   repositories, resolves each default branch once, and records only
   `owner/repository@40-character-commit` locators.
2. `tools/corpus-scan.ts` reads those immutable locators through GitHub's tree
   and blob APIs. It never clones with credentials, executes scripts, or writes
   to a sampled repository.
3. Only the root `package.json`, `pnpm-workspace.yaml`, and candidate workspace
   `package.json` files are materialized in a fresh temporary directory. The
   normal CLI analyzer then applies the same canonical-root, workspace glob,
   dependency visibility, and symlink-boundary policy used for local projects.
4. Dependency/VCS/vendor/generated/build/distribution directories and symlink
   tree entries are excluded. The default ceilings are 20,000 tree entries,
   500 manifests, depth 12, 1 MiB per file, and 10 MiB decoded bytes per
   repository. A GitHub-truncated tree or any local limit marks the repository
   `truncated`; API, decoding, or analysis errors mark it `failed`. Neither
   status contributes to promoted totals.

The scan reports root-only and workspace-full counts separately. This prevents
root-only PS040 results from being presented as monorepo truth.

## Durable draft artifacts

The workflow artifact contains:

- `repos.txt`: the exact immutable sample;
- `findings.jsonl`: stable finding IDs, immutable source URLs, script SHA-256,
  rule metadata, spans, and redacted messages—never raw script source;
- `corpus-run.json`: selected manifest paths, scanner/source commit and hashes,
  rule-registry hash, limits, sample method/seed, environment, per-repository
  status, separate scan modes, artifact hashes, and reproduction command;
- `summary.md`: an explicitly unverified summary for maintainers.

The run fails if any repository fails, while still leaving `corpus-run.json`
for diagnosis. Truncation is visible and excluded rather than silently treated
as a complete sample. Expiring workflow artifacts supplement; they do not
replace a reviewed, versioned evidence record.

## Human adjudication gate

Before publishing any precision percentage:

1. Select at least 100 findings using a deterministic sample stratified across
   rule ID, severity, and confidence. A frequent rule must not dominate.
2. For each finding, record the fields in
   [`adjudication.schema.json`](adjudication.schema.json): outcome, rationale,
   immutable evidence URL, reviewer, and review date. `unclear` and `disputed`
   cases never count as true positives.
3. A second reviewer checks every false positive/disputed item and a
   deterministic sample of at least 20% of the remaining decisions. Record the
   secondary decision and date in the same row.
4. Precision is `true_positive / (true_positive + false_positive)` after the
   review requirements pass. Report overall and per-rule denominators. The P0
   high-confidence subset has its own ≥95% gate; the overall gate is ≥85%.
5. Every confirmed false positive or false negative becomes a versioned
   regression fixture before its parser/rule fix merges.

The August 2026 run reviewed only 62 findings and predates the target-specific
parser/workspace scanner. It is historical signal, not v0.1 release evidence.

## Shared competitive comparison

Any scripts-doctor comparison must use the same pinned fixture corpus, an exact
tool version, a pinned Node/container environment, captured commands and raw
outputs, and the same human adjudication fields. Until that harness and review
exist, scriptspect makes no head-to-head superiority claim.

## Publication and community safety

- Only a maintainer-reviewed, versioned ledger may support public metrics.
- Draft, partial, overdue, or failed runs leave the relevant gate `OPEN`.
- No issue, pull request, comment, email, or other third-party write is made
  from corpus automation. Such contact requires explicit human authorization.

