---
"@paddock/server": patch
---

Decouple the keeper/scratch replace system-prompt from `PADDOCK_DEV_SERVERS_ENABLED` (#176). Whether an agent uses the native Claude Code system prompt + CLAUDE.md hierarchy vs. a terse Paddock replace prompt is now its own explicit decision, driven by `PADDOCK_KEEPER_NATIVE_PROMPT` (default `true` — native — on every instance) instead of piggy-backing on the unrelated dev-servers capability flag. Scratch chats now also get the native default + instance-wide CLAUDE.md by default. Set `PADDOCK_KEEPER_NATIVE_PROMPT=false` to keep the old replace prompt on an instance with no CLAUDE.md files.
