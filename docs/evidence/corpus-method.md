# Corpus validation methodology

This is the reproducible, read-only process used to test scriptspect against
public code. A machine scan produces a **data draft**, not a precision claim.

## Immutable scan

1. The manual/monthly corpus workflow captures the complete first page of two
   popularity-ranked GitHub Search strata (JavaScript and TypeScript), including
   each query, response hash, rank, star count, and repository. It then uses a
   deterministic rank-by-rank round robin and de-duplicates a repository at its
   first appearance. The full ordered snapshot is preserved rather than sorting
   away its rank or stratum.
2. The resolver batches candidates through GitHub GraphQL. One response anchors
   the default-branch commit and root `package.json` blob together. Only an exact
   `NOT_FOUND` error at that candidate's root-file field is an eligibility
   exclusion; every other partial error or response mismatch fails closed. The
   resolver records only `owner/repository@40-character-commit` locators and
   hashes the complete ordered candidate snapshot into its evidence.
3. `tools/corpus-scan.ts` makes one bounded recursive-tree REST request per
   selected repository. It reads each selected manifest from
   `raw.githubusercontent.com` at the exact commit without an Authorization
   header, then verifies byte length and the Git blob OID from the immutable tree
   before analysis. Manifest downloads therefore do not consume per-blob GitHub
   REST core requests. The scanner never clones, executes scripts, or writes to
   a sampled repository.
4. Only the root `package.json`, `pnpm-workspace.yaml`, and candidate workspace
   `package.json` files are materialized in a fresh temporary directory. The
   normal CLI analyzer then applies the same canonical-root, workspace glob,
   dependency visibility, and symlink-boundary policy used for local projects.
5. Dependency/VCS/vendor/generated/build/distribution directories and symlink
   tree entries are excluded. The default ceilings are 20,000 tree entries,
   500 manifests, depth 12, 1 MiB per file, and 10 MiB decoded bytes per
   repository. A GitHub-truncated tree or any local limit marks the repository
   `truncated`; API, decoding, immutable-blob verification, or analysis errors
   mark it `failed`. Neither status contributes to promoted totals. GitHub HTTP
   failures retain their status, rate-limit limit/remaining/reset/used/resource,
   Retry-After, request ID, and a rate/auth/permission classification; request
   credentials are never persisted. Findings from truncated or failed
   repositories are also excluded from `findings.jsonl`, so the adjudication
   draft cannot silently sample incomplete repositories.

The scan reports root-only and workspace-full counts separately. This prevents
root-only PS040 results from being presented as monorepo truth.

## Durable draft artifacts

The workflow artifact contains:

- `repository-candidates.json`: the complete ordered popularity-strata snapshot,
  including query metadata, ranks, repositories, response hashes, and status;
- `repository-sample.json`: candidate-snapshot SHA-256, deterministic method,
  GraphQL request/cost evidence, rootless replacements, and selected immutable
  commits/root-manifest blobs;
- `repos.txt`: the exact immutable sample;
- `findings.jsonl`: stable finding IDs, immutable source URLs, script SHA-256,
  rule metadata, spans, and source-free rule summaries—never raw script source;
- `corpus-run.json`: selected manifest paths, scanner/source commit and hashes,
  rule-registry hash, limits, sample method/seed, hashes of the full candidate
  snapshot and sample evidence, environment, per-repository status, separate
  scan modes, artifact hashes, and a directly copyable POSIX-shell reproduction
  command;
- `summary.md`: an explicitly unverified summary for maintainers.

To replay a run, place its `repository-candidates.json`,
`repository-sample.json`, and `repos.txt` beside the repository checkout, set
`GITHUB_TOKEN` externally to a read-only public-repository token, and run the
command recorded in `corpus-run.json`. The command checks out the exact source
commit and fails unless HEAD, the index, and every tracked file are clean. Every
tracked-index tag other than ordinary `H` is rejected. The preflight reads
separate NUL-delimited `git ls-files -v` and `git ls-files -f` results so Git's
`assume-unchanged`, `skip-worktree`, and `fsmonitor-valid` hiding flags cannot
mask a changed file. The validator source is embedded once in the reproduction
command rather than loaded from the checkout it is validating. It parses the
raw NUL-delimited `HEAD` tree and hashes every regular file's worktree bytes
with the repository's Git object algorithm; clean/smudge filters, EOL or
working-tree encodings, symlink emulation, racy stat data, and hidden index bits
therefore cannot substitute different bytes. POSIX executable bits and raw
symlink targets must match their tree modes. Gitlinks are rejected rather than
trusted as submodules. Git is invoked without an interpolating shell, and
NUL-delimited output plus literal pathspec arguments preserve unusual evidence
filenames. Working-tree, cached, and status checks explicitly do not ignore
submodules; any Git or filesystem failure is fatal. Apart from the three named
evidence inputs, any nonignored untracked file is also a failure. These checks
run both before and after the frozen-lockfile install, before the scanner
starts. Replay requires the exact recorded Node version, platform, and
architecture; it restores the recorded `RUNNER_OS` value or explicitly unsets
it. It also binds the complete canonical limits JSON, original generation
timestamp, sample method and seed, candidate snapshot, sample evidence,
repository list, and a new deterministic output directory to the scanner's
actual environment variables and positional arguments. The command refuses to
reuse that output directory. Only evidence basenames and a token-variable
reference are recorded; neither the credential nor a local absolute path is
persisted. A run recorded on another platform must therefore be replayed in a
matching environment with the recorded Node patch version.

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
