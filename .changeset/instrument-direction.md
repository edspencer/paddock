---
"@paddock/web": minor
"@paddock/server": minor
---

Design direction A — `instrument`: Paddock as a piece of precision equipment.

A cool graphite/anodised palette (OKLCH, light and dark derived separately) with
a single functional accent — signal cyan — that means *live* and never
decorates. IBM Plex Sans / IBM Plex Mono, self-hosted, with tabular figures as
the app-wide default. Small radii, tightened elevation, dense layout.

Adds a **fleet readout**: a persistent rack meter above every route showing how
many turns are running, how long each has been going, in which project, and how
close each is to its context limit. Two small server changes make it honest
rather than decorative — the session hub now records when a turn started (so the
clocks survive a page reload), and the attention feed resolves token usage for
running chats.
