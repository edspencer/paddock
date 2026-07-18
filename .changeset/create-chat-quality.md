---
"@paddock/server": patch
---

Self-MCP `create_chat`: honor the `name` param + clearer guidance (#264)

The `create_chat` tool accepted a `name` argument but silently dropped it, so a
manager fanning out children got chats titled by Claude's ~15-word auto-summary
of the first turn instead of the concise title it asked for.

- **Wire the `name` param.** After the chat is created, the callback applies the
  name via `renameSession` (mirroring how `fork_chat` names a fork), so the
  caller-supplied title wins over the auto-derived first-message name.
- **Short-title guidance.** `CREATE_CHAT_DESC` and the `name` schema now instruct
  the caller to pass a concise **3–5 word** title.
- **Preload description parity.** The `preload_context` wording now names both
  **OVERVIEW.md** and **CHANGELOG.md** (the behaviour already injected both —
  only the description was stale), matching the UI checkbox.
- Deduped the two identical OVERVIEW+CHANGELOG preload blocks (human New-Chat
  path + `create_chat` spawn path) into one shared `composePreloadedPrompt`
  helper.
