---
"@paddock/server": minor
"@paddock/web": minor
---

Star (pin) chats to the top of the list (#373). A new per-chat star flag,
orthogonal to archiving, floats starred chats to the top of both the active list
and the Archived section (order preserved within each group). Backed by a
`StarStore` sidecar mirroring `ArchiveStore`, with `POST /api/projects/:slug/chats/:sessionId/star`
(and a scratch equivalent) and a rightmost, gold star action on each chat row.
