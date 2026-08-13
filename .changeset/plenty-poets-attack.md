---
"@paddock/server": patch
"@paddock/web": patch
---

Running-work bar: collapse/expand toggle, and name the kind of work in the header.

A big fan-out used to render one row per running thing, always — a real session
hit fifteen rows, taller than the composer the bar docks above, pushing the
conversation off screen at the moment you most want to read it. The header row is
now a toggle: above four rows the bar starts collapsed to a single line showing
the mix (`6 shells · 1 monitor`) or, when every row is the same kind, what the
newest one is doing — with `oldest 15:00` on the right, the number that tells you
something is wedged rather than merely slow. The choice is decided once per
appearance of the bar and never changes reactively, so it cannot move under a
click.

The header also names the kind when the bar is homogeneous — `15 shells running`
rather than `15 things running`.

Fixes the labelling bug underneath that (#846): the SDK puts its internal task
discriminants on the wire (`local_bash`, `local_agent`, `monitor_mcp`, …), not
the friendly names Paddock was written against, so every row rendered a raw
`local_bash` and a neutral clock. The server now maps type to role once, at the
registry boundary, and keeps the raw value alongside so an unfamiliar kind is
still diagnosable.
