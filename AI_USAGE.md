# AI Usage Policy

scriptspect welcomes AI-assisted contribution — with hard gates that keep the tool trustworthy.

## Where AI helps

- Scoped implementation work (a rule, a fixer, a reporter) from a clear issue
- Generating test candidates and fixtures, including adversarial negative cases
- Summarizing issues/PRs, drafting docs, checking README examples against actual output

## Where AI is not authoritative

- **Rule correctness is never established by AI opinion.** Shell-behavior claims must be backed by repeatable fixtures and cited provenance (official shell docs, man pages, or public failure cases).
- AI-generated patches go through the same human review + CI as any patch. Large rewrites are not auto-merged; parser/rule/fixer changes keep a human review gate.
- Maintainers may reject AI suggestions at their discretion and default to the conservative option in high-risk parser/fixer changes.

## Guarantees that do not depend on trust

- The tool is deterministic and offline at runtime: no model calls, no telemetry, no script execution.
- Every rule ships positive and negative fixtures; CI runs on Linux, Windows, and macOS, so "works on the author's machine" is never the bar.
