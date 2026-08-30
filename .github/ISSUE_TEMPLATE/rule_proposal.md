---
name: Rule proposal
about: Propose a new detection rule
labels: enhancement, rule
---

**Proposed rule ID** (next free ID in the series, see docs/rules)

**Script pattern to detect**

```json
"scripts": { "build": "..." }
```

**Why is it a portability problem?** (which shells/OS break, and what actually happens)

**Suggested fix direction** (rimraf / shx / cross-env / Node helper / manual)

**Evidence of the shell behavior** (official docs, man pages, or a public project where this failed)

**False positives to avoid** - cases that must NOT be reported

**Rule contribution checklist** (see docs/contributing-rules.md)

- [ ] metadata: ruleId/title/summary/severity/confidence/affectedTargets
- [ ] at least 2 bad + 2 good examples
- [ ] at least 3 positive + 3 negative fixtures
- [ ] fix safety class + provenance
