---
"@paddock/web": minor
"@paddock/server": minor
---

Finished chats no longer vanish from the fleet strip. When a turn lands and you haven't read the reply, its channel stays on the strip to the right of anything still running, with a dashed outline and "4m ago" in place of the clock, until you open the chat. The channel row now scrolls sideways (no scrollbar, faded edges, and a plain mouse wheel works) instead of collapsing to "+N". Home's separate Running and Unread tables are now one **Running & Recent** table: live turns first, in the same order as the strip, then every other chat newest first, with unread ones marked. It shows ten and folds the rest behind "Show more". `GET <workspace>/chats/attention` gains a `recent` list (capped at 50), and every list it returns is now ordered newest activity first.
