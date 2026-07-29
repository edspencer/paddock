---
"@paddock/server": patch
"@paddock/web": patch
---

Stop computing usage rings nobody can see (#537). `GET
/api/projects/:slug/chats/usage` computed the context-ring fill for **every**
chat in a project, and there is no stored counter for that — each session's fill
is derived by streaming its transcript (and its sub-agents') end to end and
`JSON.parse`-ing every line. The sidebar collapses the Archived group by default,
so on a live-scale project most of that I/O produced rings that were never
rendered: of 234 chats and 495 MB of transcript, **182 chats and 349 MB (71%)
were archived**. The endpoint is called on every project open and after every
completed turn, per open tab.

The endpoint is now scoped: `?scope=active` (the new default) / `archived` /
`all`. The client asks for the archived half only once that group is actually
expanded. The lazy fetch keys off the group's **expanded state**, not the
disclosure button, because three separate things open it — the user toggling it,
archiving a chat, and deep-linking into an archived chat — and the failure mode
here is invisible (a ring that silently never appears). A turn completing
refreshes the archived rings only for a client that has already asked for them.

Also raises `MTIME_CACHE_MAX` (the sub-agent transcript memo) from 64 to 1024.
That corpus holds 514 transcript files for 234 chats, so at 64 a single sweep
evicted every entry before the next sweep could reuse one and the cache was pure
overhead. The entries are token tallies, not transcript text: pushing all 1,515
sessions in the corpus through both cached paths and then forcing GC retained
1.4 MB at the new cap versus 1.3 MB at the old one.

Measured on that corpus (v0.51.0 build vs. this one, same data, interleaved):
project open 4.18 s → **1.23 s** cold and 0.40–0.54 s → **0.014–0.021 s** warm.
Expanding Archived costs 3.05 s once, then 0.020 s. The two changes are not
redundant: scoping alone takes the warm call to 0.047–0.095 s and is the only
thing that moves cold; the cache cap takes it the rest of the way, and is worth
15× on its own for a same-scope call (0.44 s → 0.029 s at `scope=all`).
Behaviour is unchanged:
`active ∪ archived` is exactly the old response — same 234 keys, zero differing
fields — and the 234 rendered rings are byte-identical, in the same order,
between the two builds.
