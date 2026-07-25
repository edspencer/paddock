---
"@paddock/server": minor
"@paddock/web": minor
---

feat(chat): per-message hover — context usage + timestamp, Fork-from-here & Revert-to-here

Hovering a message in the transcript now reveals a small rail at its top-right
showing **when** that message happened and **how full the context window was** at
that point, plus two actions: **Fork a new chat from here** and **Revert
conversation back to here**. On a long chat this answers "is this from minutes or
days ago?" and "where did the context actually fill up?", and lets you branch off
or roll back from any earlier point.

- **Per-message context + timestamp.** Each assistant turn's `usage` already
  equals the context-window fill at that moment (`input + cache_read +
  cache_creation`), so this is a point-in-time read, not a cumulative sum. A new
  mtime-cached `readContextSeries` pass maps each transcript record `uuid` to its
  fill; the messages endpoint forward-fills it across the turns between, so every
  message can answer "how full was the window as of here". The chat-LIST path is
  deliberately untouched — this runs only when a chat is open, so the sidebar
  stays lean.
- **Fork from here.** `forkSession` gains an optional cut point: the new chat
  copies only the transcript PREFIX up to the chosen message (tool_use/tool_result
  pairing preserved) instead of the whole history. The source is untouched. Both
  the HTTP route and the `fork_chat` MCP tool inherit it.
- **Revert to here.** New `revertSession` truncates the chat in place, keeping its
  session id (so the URL and lineage survive) and backing the dropped tail up to a
  `.reverts/` sidecar. Reverting to one of your OWN messages rewinds to the
  assistant's previous reply rather than leaving a dangling un-answered prompt —
  otherwise resume replays it as a phantom turn and the model reads your
  instruction as stale backlog.
- **Revert warns about side-effects.** The confirm dialog counts the messages and
  tool calls that will be removed and states plainly that those actions (files
  written, PRs opened, messages sent) are **not** undone — only the conversation.
- The rail is keyboard-accessible (`focus-within` reveal + focus rings), anchors
  on the record `uuid`, and appears only on reloaded user/assistant turns — never
  on tool cards, notices, or live-streaming turns.
