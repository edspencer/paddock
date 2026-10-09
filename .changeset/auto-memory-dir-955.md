---
"@paddock/server": patch
---

Agents can save memories again under `claude.transcripts: host` (#955). Every memory write there was denied as "a sensitive file". The memory folder is reached through Paddock's transcript symlink into `~/.claude`, and Claude Code resolves symlinks before deciding a write is a memory write. Paddock now gives each keeper and trigger agent the memory folder's real path as `autoMemoryDirectory`. It is the same folder as before, so no memories move. Applied under `own` too, where writes only worked because the default `Write` allow rule happened to cover `.chats/`. Docker projects are unchanged.
