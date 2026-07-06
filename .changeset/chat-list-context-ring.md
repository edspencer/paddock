---
"@paddock/server": minor
"@paddock/web": minor
---

feat: per-chat context-window ring in the chat list (#77)

Each chat in a project's chat list (and the scratch/one-off list + landing
preview) now shows a tiny circular gauge filled to that chat's context-window
usage, mirroring the in-chat `ContextMeter` (same `tokens / limit` percentage,
amber at ≥80%). The ring hides for chats with no usage data yet.

Server-side, the chat-list DTOs (`GET /api/projects/:slug`,
`/api/projects/:slug/chats`, `/api/chats`) now include `contextTokens` /
`contextLimit`, derived from the same `sessionUsage` + `getContextLimit` the
`/context` endpoint uses. Per-session usage reads are memoized on transcript
mtime (`HerdctlService.sessionUsageCached`) so an unchanged transcript isn't
re-scanned on every list build.
