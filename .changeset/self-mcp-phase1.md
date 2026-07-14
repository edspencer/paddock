---
"@paddock/server": minor
"@paddock/web": minor
---

Add the read-only Paddock self-management MCP (issue #214, Phase 1). When `PADDOCK_SELF_MCP` is set, keeper turns are handed a `paddock_manage` MCP server exposing three read-only tools — `list_projects`, `list_chats` (cross-project), and `read_chat` (a trimmed, length-capped transcript tail) — so a keeper can inspect Paddock itself. Injected via herdctl's `injectedMcpServers` (same mechanism as `send_file`); keeper-only (never scratch) and off by default. Write tools (create/fork/message) and the external bridge are later phases.
