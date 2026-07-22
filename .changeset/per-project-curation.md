---
"@paddock/server": minor
"@paddock/web": minor
---

Per-project curation budget overrides (#384). The sweeper's three token budgets (OVERVIEW / CHANGELOG / CLAUDE.md) can now be set per-project — in `project.yaml` (`curation:`) and in the project Settings tab — overriding the instance defaults from #383 field-by-field. Mirrors the existing `recovery`/`attachments` per-project-override pattern: a new `curation-config.ts` resolver, sanitisation on read/write, resolution at sweep time, and inherit/override/clear UI showing the instance default (exposed via `GET /api/models` as `curationDefault`).
