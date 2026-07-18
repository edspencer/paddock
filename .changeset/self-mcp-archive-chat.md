---
"@paddock/server": minor
---

self-MCP: add `archive_chat` / `unarchive_chat` write tools (#263)

The self-management MCP now lets a keeper archive (and unarchive) a chat — most usefully **itself**, which powers the self-reporting convention "do the work, then archive myself on success; leave un-archived on failure so it's flagged when a human logs in."

- Two new write tools, gated by the same `PADDOCK_SELF_MCP_WRITE` flag as `create_chat`/`fork_chat`/`send_message`.
- `session_id` is **optional** and defaults to the **current** chat (mirroring how `send_message` defaults `project`), so an agent can archive/unarchive itself without knowing its own id; `project` likewise defaults to the current one.
- Wired through a new `SelfMcpWriteContext.setArchived` callback that delegates straight to the existing `ArchiveStore` (presentational metadata only — no keeper turn is started), keyed by the target project's keeper agent, matching the existing POST archive endpoints.
