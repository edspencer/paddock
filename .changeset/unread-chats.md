---
"@paddock/server": patch
"@paddock/web": patch
---

Add a subtle "unread" affordance to per-project chat rows: a chat is marked unread when the agent finishes a turn while the user isn't viewing it, and read when opened/focused. Adds a `lastTurnCompletedAt` chat DTO field sourced from herdctl job records (#160).
