---
"@paddock/server": patch
---

Chat history no longer renders injected Claude Code context — a skill's `SKILL.md`, slash-command output — as a giant, out-of-order user message. `sessionMessages` now re-reads the raw transcript and drops `isMeta` user lines that `@herdctl/core`'s parser surfaces as ordinary user messages. Fixes #31.
