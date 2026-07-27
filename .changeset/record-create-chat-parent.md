---
"@paddock/server": patch
---

fix(chats): record the creating chat on `create_chat`, so the chat tree stops relying on inference (#509).

The nested chat list resolves a parent edge from `RunProvenance.parentSessionId`
first, falling back to inferring one from the kickoff message's sender. But
`startAgentTurn` rebuilt the provenance marker from loose `origin`/`depth`
scalars, dropping the parent on the `create_chat` path — the dominant way
children are made. Result: **not one** of the 169 provenance records on the
dogfood instance carried the field, and every edge in the live tree came from
inference, which had already needed narrowing once (#491/#504) after it
re-parented human chats that a child reported back to.

`StartAgentTurnOpts` now carries an optional `parent`, `create_chat` supplies the
calling chat, and the stamp persists it. Absent where there is no calling chat
(schedule/hook fires, and the external `/mcp` transport, which binds
`currentSessionId` to `null`). Inference is unchanged and still backfills
historical chats — this only stops manufacturing new ones that need it.
