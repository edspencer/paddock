---
"@paddock/web": minor
---

Chat list: a running-chats filter on the count badge, and a nested/flat view toggle

The "Chats" count badge splits when a turn goes live: total on the left,
running count on the right, and the right half toggles the list down to just the
chats working right now. Running chats were always findable by hunting for
spinning rings down the sidebar; now they are a target you can hit.

The filtered view renders FLAT. A running child sitting under its running parent
would reintroduce exactly the indentation the filter exists to remove, so the
running view drops nesting entirely — and it keeps the chat you currently have
open pinned in, so it cannot vanish from under you the moment its turn finishes.
Filtering to running composes with search rather than fighting it, and when the
last turn ends the list says "No chats are running" and offers the way back,
because the filter is sticky and can outlive the work it was filtering for.

Nesting itself is now optional: a view-options button next to "+" opens a small
inline panel with a Nested / Flat choice. Both preferences are per-browser and
global, not per-project — how you like to read a list is not a per-project fact.
