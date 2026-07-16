---
"@paddock/web": minor
---

Render `Edit`/`MultiEdit`/`Write` tool calls as an inline diff (issue #232).
Edit tool calls previously showed only the file path + a generic success line; you
couldn't see what changed. The before/after is now recovered server-side from the
raw `tool_use.input` (which herdctl's parser drops), turned into a compact
line-level diff, and rendered in the tool block with `+`/`−` green/red coloring —
a filename + `+A −D` stat in the header, the colored diff on expand. `MultiEdit`
shows one labelled hunk per sub-edit; `Write` renders as all-additions. Enrichment
mirrors the sub-agent/background reader (raw-input recovery + positional join); no
herdctl change and no diff dependency. History-hydrated only (like #230), so live
edits get the diff on reload.
