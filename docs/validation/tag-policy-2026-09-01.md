# Release tag policy evidence — 2026-09-01

This ledger records the repository-side controls for the first `v0.1.0` release. It does not claim that a release or npm package exists: the repository had zero tags when the controls were verified, and no test tag was created.

## Active GitHub controls

| Ref class | Ruleset | Effective policy |
| --- | --- | --- |
| Immutable `refs/tags/v*.*.*` creation | [`22006456`](https://github.com/Tom409114/scriptspect/rules/22006456) | Active `creation` restriction; only a repository deploy key may bypass. |
| Immutable `refs/tags/v*.*.*` mutation | [`21964642`](https://github.com/Tom409114/scriptspect/rules/21964642) | Active `update` and `deletion` restrictions with no bypass actor. This rule is layered with `22006456`, so the release deploy key may create an immutable version tag but may not move or delete it. |
| Floating `refs/tags/v0` and `refs/tags/v0.1` aliases | [`22006468`](https://github.com/Tom409114/scriptspect/rules/22006468) | Active `creation`, `update`, and `deletion` restrictions; only a repository deploy key may bypass for the coordinator's exact compare-and-swap operations. |

The dedicated verified write deploy key has repository key ID `161938616`. Its private key exists only as the `RELEASE_TAG_DEPLOY_KEY` secret in the protected `release` environment; it is not a repository-level secret or a tracked/local file. The environment requires owner review and accepts only `main` or `v*.*.*` deployment refs.

## Credential isolation contract

- `.github/workflows/release.yml` creates or verifies the immutable tag in the dedicated `create-protected-tag` job. That job runs only fixed shell, Git, and OpenSSH commands: it does not check out or execute candidate code, package scripts, or repository tools.
- The mutator validates the exact repository, stable version, tag, authorized commit, and main ancestry. It pins GitHub's ED25519 host key, uses strict host-key checking, creates the tag without force, verifies the remote target, and removes key material with an exit trap.
- `.github/workflows/npm-publish.yml` is invoked only by the coordinator's exact tag-bound `workflow_dispatch`; a deploy-key tag push cannot create a second publisher run.
- Floating aliases are moved or restored only in two isolated shell-only credential steps. Each independently reloads durable release state, derives the exact `v0`/`v0.1` names from the authorized version, validates both targets and previous targets, and uses `--force-with-lease`. Candidate code never receives the deploy key.

## Verification snapshot

The GitHub API returned all three rulesets as `active`, the deploy key as `verified: true` and `read_only: false`, and the environment secret metadata under `release`. The repository secret list was empty and the tag list length was `0`. Local workflow contract tests cover credential scope, fixed known-host data, tag immutability layering, dispatch-only publication, and exact alias CAS.

GitHub's documented semantics are the basis for these controls: [restrict creation/update/deletion rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [ruleset layering and bypass actors](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), and the [repository rulesets REST schema](https://docs.github.com/en/rest/repos/rules).
