---
"@paddock/server": patch
---

Bump `@herdctl/core` to `^5.24.0`, bringing two upstream fixes: in-flight (unpaired) `tool_use` blocks are now surfaced when rehydrating a transcript (`ChatToolCall.pending`), so a running foreground `Agent`/Task sub-agent no longer vanishes from the reconstructed history on refresh (herdctl#399); and `getAgentSessions` is now worktree-aware, so a keeper session that enters a native git worktree stays discoverable/attributed instead of dropping out of the sidebar (herdctl#401).
