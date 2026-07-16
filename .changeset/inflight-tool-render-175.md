---
"@paddock/server": minor
"@paddock/web": minor
---

fix(#175): render in-flight tool calls (esp. subagents) with a pending "running…" state

Long-running tools — especially subagents (`Task`/`Agent`) that run for minutes —
previously showed nothing in the transcript until they completed, because the
live stream only surfaced a tool once its `tool_use` was paired with its
`tool_result`. Consuming `@herdctl/chat@0.6.0`'s new `onToolStart`, the server
now emits a `chat:tool_start` frame the moment a tool begins (carrying
`toolUseId` + `parentToolUseId`), and adds `toolUseId` to `chat:tool_call` so the
completion can be reconciled. The web client appends a pending tool row on
`chat:tool_start` (spinner + "running…", keyed by `toolUseId`) and replaces it
in place when the matching `chat:tool_call` arrives — so a slow tool/subagent is
now visibly in flight instead of invisible until done. Reconnect-safe (dedups
replayed start frames) and backward compatible (falls back to append when no
pending row exists).
