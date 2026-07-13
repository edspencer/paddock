---
"@paddock/server": patch
"@paddock/web": patch
---

Persist chat read/unread state server-side (#189)

Read-state (per-chat "last seen") moves off browser localStorage into a
write-through JSON sidecar (`read-state.json`) in the data dir, so it follows a
user across devices hitting the same instance. Keyed by username WHEN a real
identity is present (trusted-header / jwt), else a single shared bucket
(`none` mode / anonymous) — forward-compatible with multi-user without gating
chat visibility. The chat DTO (list + detail) and `/api/projects` `chatTurns`
now carry `lastSeen`; new `POST /api/projects/:slug/chats/:sessionId/seen`
(and scratch `/api/chats/:sessionId/seen`) mark a chat seen, and `GET /api/me`
exposes the principal. The web `lastSeen` helper becomes a thin cache layering
the server value (source of truth) over an optimistic localStorage mirror.
