---
"@paddock/server": patch
---

Bump `@herdctl/core` to 5.20.0. This fixes the session-reaper closing a keeper's
streaming session out from under it when a **synchronous** subagent finishes —
the "keeper stops right after a subagent completes" stall seen on session
drive-mode instances (herdctl #366 / PR #367). Also picks up the harness
`<task-notification>` transcript-parser fix (herdctl #364).
