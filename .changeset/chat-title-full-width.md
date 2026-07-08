---
"@paddock/server": patch
"@paddock/web": patch
---

Give chat-list titles the full row width at rest (#104).

Each chat row's title button reserved a fixed right padding (`pr-[6.75rem]`) for
the fork/rename/archive/delete actions at all times, even though those actions
live in an `absolute`, `opacity-0` overlay that only fades in on hover/focus. So
at rest a title was squeezed into ~half the available width and truncated early,
leaving a large empty gap where the (invisible) icons would appear.

The reserved padding is now conditional: a small default (`pr-2.5`) at rest,
bumped to `pr-[6.75rem]` under `group-hover/chat` / `group-focus-within/chat` so
the title contracts to make room only when the icons actually become visible.
Archived rows keep a persistent archive icon, so they retain just enough room
for that one icon (`pr-[3.75rem]`) at rest.
