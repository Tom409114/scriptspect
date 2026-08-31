# Shared-corpus comparison harness

This harness runs ScriptSpect and
[scripts-doctor](https://github.com/Ashwani2529/scripts-doctor) over the exact
same repository-owned package fixtures. It captures observations for human
review; it does **not** calculate a winner or authorize a superiority claim.

## Pinned toolchain

- Node.js `22.23.2`;
- `scripts-doctor@1.0.0`, exact package version and SHA-512 integrity recorded
  in [`toolchain.json`](toolchain.json) and `pnpm-lock.yaml`;
- the checked-out ScriptSpect commit, required to equal `HEAD`;
- fixture bytes indexed by
  [`tests/fixtures/comparison/corpus.json`](../tests/fixtures/comparison/corpus.json).

The scripts-doctor command is invoked directly from the frozen local install;
the harness does not use `npx`, `latest`, a network lookup, or either tool's
write/fix option.

## Reproduce

Use the pinned Node version, start with a clean checkout, and choose a new
output directory:

```bash
corepack pnpm@11.24.0 install --frozen-lockfile --ignore-scripts
pnpm build
SCRIPTSPECT_SOURCE_COMMIT="$(git rev-parse HEAD)" pnpm exec tsx tools/comparison/run.ts comparison-output
```

`comparison-run.json` records commands, exact environment, fixture and output
hashes, exit codes, path normalization, and whether the run is eligible for
review. Stdout, stderr, and each available machine report are retained. The
generated `comparison-adjudication-draft.jsonl` follows
[`adjudication.schema.json`](adjudication.schema.json); every row remains
`pending` until named reviewers supply a rationale and date.

## Claim boundary

A promotable run still does not prove accuracy. Reviewers must judge both tools
against each fixture question, secondary-review disagreements and error cases,
and publish denominators with the versioned ledger. Until that happens,
[`docs/comparison.md`](../docs/comparison.md) continues to state that no
head-to-head conclusion exists.

