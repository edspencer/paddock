---
"@paddock/server": minor
"@paddock/web": minor
---

Add the Paddock self-management MCP **write tools** (issue #214, Phase 2). Behind the new `PADDOCK_SELF_MCP_WRITE` flag (on top of `PADDOCK_SELF_MCP`), keeper turns additionally get `create_chat`, `fork_chat`, `send_message`, and `fork_chat_batch` (fan-out) on the `paddock_manage` MCP server. These start real keeper turns routed through the shared SessionHub, so a spawned chat appears in the sidebar and streams live exactly like a human-started one. Fan-out (`fork_chat_batch`, cap 20) lets a keeper fork the current chat N times, one kickoff per work-item. Keeper-only; off by default; gated separately from the read tools because they start real work. No recursion guard yet (per #214) — spawned chats get `send_file` but not the self-MCP, so v1 fan-out is one level deep.
