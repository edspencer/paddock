---
"@paddock/server": patch
---

Sweeper now maintains a per-project `CLAUDE.md` (durable identity & conventions) alongside `OVERVIEW.md` (current state) and `CHANGELOG.md` (history) (#177). A minimal `CLAUDE.md` is seeded at project creation, and each sweep may emit an optional `<<<CLAUDE>>>` section carrying only genuinely-new durable facts; `SweepService` **appends** them under a managed "Curated notes" heading rather than rewriting, so human-authored conventions are never clobbered. When the sweeper has nothing durable to add it emits `NOCHANGE` and the file is left untouched. Pairs with #176 so the per-project `CLAUDE.md` is auto-loaded as the project layer of the two-level native-context model.
