---
"@paddock/server": patch
---

chore(deps): bump @herdctl/core to ^5.19.0

Picks up the session-discovery performance work in core 5.19.0: derived
per-session facts (isSidechain, usage) are now persisted in the metadata store
keyed on mtime, the `getAgentSessions` enrichment loop runs with bounded
concurrency, and the attribution index rebuilds incrementally. Together these
cut the per-switch work that made project switching slow — the usage-ring reads
Paddock issues via `chats/usage` (and the per-chat `/context` endpoint) now hit
a durable, restart-surviving cache instead of re-streaming every transcript.
