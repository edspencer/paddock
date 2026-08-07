---
"@paddock/server": patch
---

Destructive chat operations now stop an in-flight turn instead of racing it
(#731). Deleting a chat mid-turn used to lose the whole conversation.

A chat's transcript is written by `claude` itself, straight through the symlink
Paddock plants — Paddock never holds the file handle. So unlinking the JSONL
while a turn was live did not delete the chat: the surviving process wrote itself
back, and the chat returned named after its raw session id with a 3-line
transcript that opened on an orphan `tool_result` and no prior history at all.
Promote lost the chat from **both** projects — the source resurrected a stub, the
target's list came up empty, and `adoptable-chats` reported nothing, so the UI
offered no way back. A hung turn was never reaped, leaving a `claude` child alive
and a `status: "running"` run row that never cleared.

`DELETE /chats/:id`, `POST /chats/batch/delete`, `POST /chats/:id/revert`,
`POST /chats/:id/promote` and `DELETE /api/projects/:slug` now cancel the turn
and **wait for it to be verifiably dead** before touching a byte, reporting
`cancelledTurn: true` when they did. Each is an unambiguous "this chat's current
state is going away", and refusing instead would strand the user behind a turn
that may never end. If the turn cannot be confirmed dead within 10s they return
`409 { code: "turn_running" }` rather than mutate under a live writer — the
resurrection is impossible by construction, not by winning a race.

Fork is deliberately **not** interlocked: the `fork_chat` fan-out (#214) is
invoked by a keeper from inside its own running turn, so the source is always
mid-flight there and refusing would break that contract. Instead the *copy* is
trimmed back to the last point where every `tool_use` has its `tool_result`, so a
mid-turn fork is no longer born with a transcript the Messages API rejects on
resume. The source is untouched either way, and an idle fork is copied
byte-identically as before.
