---
"@paddock/server": patch
"@paddock/web": patch
---

A chat's "updated X ago" — and the order the chat list is in — now comes from
the timestamp of the last real message in its transcript rather than the
`.jsonl` file's mtime (#863). Paddock touches transcripts for reasons that are
not conversation (discovery re-stats, attribution, a resume appending a mode
record), so idle chats were being restamped as "updated a few minutes ago" and
floated to the top of the list in batches, phase-locked to a periodic task.

Control records are ignored when working out that timestamp — a title entry, a
`system` line, a harness-injected `isMeta` message, a background agent's
completion notice — because all of those can be appended without anyone taking a
turn. The file's mtime remains the fallback for a transcript with no datable
record, and is otherwise untouched: it is still the cache key for auto-name,
preview, sidechain detection and usage.
