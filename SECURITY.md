# Security Policy

## Supported versions

scriptspect is pre-1.0. No npm release has been published yet, so security fixes
currently target the `main` branch. After publication, the latest npm release
will be supported alongside `main`.

| Version | Supported |
| ------- | --------- |
| `main` (pre-release) | ✅ |
| npm releases | not published yet |

## Reporting a vulnerability

Use [GitHub security advisories](https://github.com/Tom409114/scriptspect/security/advisories/new) ("Report a vulnerability"). Please do not open public issues for vulnerabilities.

We aim to respond within 7 days. Include reproduction steps and the affected rule/module if known.

## Scope notes

- scriptspect is a static analyzer: it never executes analyzed scripts (no `child_process` use against target projects) and reads only files inside the analyzed project root.
- The tool collects no telemetry and makes no network calls in normal operation.
- Never include secrets in reports; the project does not need them.
