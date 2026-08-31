# Maintainers

## Primary maintainer

- **Tom409114** — architecture, parser/rule/fixer review, releases. https://github.com/Tom409114

## Review expectations

- PRs from external contributors: first response target within 7 days
- Parser, rule, and fixer changes always require human review (no auto-merge)
- Rule behavior changes require: metadata update, fixtures, docs page, and a release-notes entry (rule IDs are public API)
- Bug fixes require a regression fixture merged with (or before) the fix

## Release responsibility

- Releases are automated via release-please; the maintainer verifies CI is green on `main` before a release PR merges
- npm publishing uses Trusted Publishing (OIDC) from GitHub Actions — no long-lived npm tokens
- After the first release, each successful release must publish the same tarball to npm and GitHub Releases with provenance and attached checksums

## Triaging

- New issues get a label within 7 days (bug / rule / docs / question)
- False-positive reports are priority: they get a regression fixture before the fix
