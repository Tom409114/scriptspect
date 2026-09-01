# Published-homepage handoff

The homepage must remain in `pre-release` state until the release workflow has
finished npm publication, provenance verification, public Release verification,
floating-alias verification, and the terminal `consumed` release state.

The transition is deliberately a second pull request. Do not include it in the
release-please PR: the README can only cite public evidence that exists after the
release commit has been published and verified.

## Prepare the evidence PR

Set the exact released version, resolve its immutable tag locally, and provide a
GitHub token for read-only evidence checks:

```bash
VERSION=0.1.0
RELEASE_COMMIT="$(git rev-parse "v${VERSION}^{commit}")"
export VERSION RELEASE_COMMIT
export GITHUB_TOKEN="$(gh auth token)"
```

1. Confirm the exact `npm-publish.yml` run succeeded. Download its
   `readme-release-receipt-v$VERSION` artifact.
2. Put the single receipt at
   `docs/validation/releases/v$VERSION/readme-release-receipt.json` without
   editing it.
3. Update `SECURITY.md` under **Supported versions** so it names the now-public
   exact release and `main`; remove the obsolete “No npm release has been
   published yet” sentence. Keep the post-release artifact policy in
   `MAINTAINERS.md`: it remains the rule for every later release.
4. Generate the status manifest from the immutable release commit and receipt:

   ```bash
   pnpm exec tsx tools/generate-readme-status.ts "$RELEASE_COMMIT" \
     --published \
     --receipt "docs/validation/releases/v$VERSION/readme-release-receipt.json"
   ```

5. Render both homepages and verify the public evidence chain:

   ```bash
   pnpm exec tsx tools/render-readme-state.ts
   pnpm exec tsx tools/verify-readme-release-evidence.ts
   pnpm exec tsx tools/check-readme-parity.ts
   pnpm exec vitest run tests/docs
   ```

6. Open a protected documentation PR. Its Generated-files CI job repeats the
   public GitHub, Release-asset, npm-integrity, and Action-alias checks. Merge only
   after every required check passes.

The receipt records IDs and digests, not just mutable names or download URLs. A
deleted-and-reuploaded asset, a non-terminal release intent, a moved tag, an npm
integrity mismatch, or a stale floating alias makes verification fail closed.
