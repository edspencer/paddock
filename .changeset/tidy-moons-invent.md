---
"@paddock/server": patch
---

`list_chats` now names a chat the way the web UI does, instead of falling through to an 8-character sessionId slice (#614).

The MCP projection used `customName ?? autoName ?? sessionId.slice(0, 8)` and
omitted the `preview` step the REST DTO has. Claude writes `ai-title` records
rather than the `summary` records `autoName` is derived from, so `autoName` is
almost never set and the chain went straight to the slice — **39 of 96 chats
(41%)** on a live instance came back named after their own sessionId.

That is worse than ugly: the stub *looks* like an id, and feeding it back to
`read_chat` returns a successful empty result rather than an error, so a caller
can conclude "empty chat" about a conversation it never opened.

The preview-recovery logic (which unwraps a preload-polluted first message back
to the user's real request) is now a shared `recoverPreview` helper used by both
`chat-dto` and the MCP list, so the two surfaces can't drift on this again.

Note this does not make `autoName` itself work — reading `ai-title` is the
remaining half of #614 and lives in `@herdctl/core`.
