---
"@paddock/server": patch
---

Per-chat cost/token estimate now includes sub-agent spend (#242)

The cumulative token totals and the ~$ estimate shown for a chat previously
priced only the main transcript, ignoring every `Task`/`Agent` sub-agent (which
run in their own sibling transcripts). Fan-out chats under-reported their true
cost — sometimes by ~90%. `readSessionTokenUsageWithSubagents` now rolls each
sub-agent transcript's per-model usage into the chat total (nested sub-agents
included), so the headline dollar figure and token count reflect the whole chat.
`contextTokens` (the last-turn context-window fill) stays main-only.
