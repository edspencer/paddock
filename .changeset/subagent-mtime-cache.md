---
"@paddock/server": patch
---

perf(server): mtime-cache the sub-agent transcript reads so refreshing a sub-agent chat skips the 2nd parse

Opening a chat that used a Task/Agent sub-agent re-streamed the **entire main
transcript a second time** (`readTaskUsesFromFile`, to recover the tool_use ids
core's parser drops) and read every sub-agent `.jsonl` in full
(`readSubagentDurationMs`) — on *every* open, including a plain refresh of an
unchanged chat. On the constrained host that doubled the ~114ms parse of a large
transcript plus the sub-agent file reads, all synchronously on the event loop.

Both per-file reads are now memoized keyed on the file's mtime (mirroring core's
message cache from herdctl #351). A transcript is immutable except when a new turn
appends (which bumps mtime), so a refresh of an unchanged sub-agent chat skips the
second parse and the sub-agent reads entirely; a new turn invalidates the affected
entries. Caches are LRU-bounded to cap memory.
