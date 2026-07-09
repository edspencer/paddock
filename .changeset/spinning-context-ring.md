---
"@paddock/web": patch
---

Chat list: merge the streaming dot into a spinning context ring and reflow rows.

The separate pulsing "response in-flight" dot is gone — the context ring now
doubles as the activity indicator: it spins while a chat is streaming (keeping
its context-fill arc, or showing an indeterminate spinner arc for a brand-new
chat with no usage yet) and reverts to the static gauge when idle. Each row is
reflowed so the title leads and the indicator floats to the far right of row 1,
while the four hover actions (fork / rename / archive / delete) drop to the
second row alongside the relative time instead of overlaying the title.
