---
"@paddock/web": patch
---

Keep polling a still-running sub-agent after navigating away and back (#725 cause B).

`useSubagentActivity` armed a sub-agent for polling only while the parent chat
was live, and kept that arming in a `useRef` — so it survived only as long as the
component stayed mounted. A background sub-agent routinely outlives its parent's
turn, and `ChatPane` is genuinely remounted on navigation, so returning to a chat
whose turn had already finished arrived with nothing armed: the poll loop
early-returned, the "N sub-agents running" bar emptied, every Task card rendered
as finished, and an expanded card's step list froze. A reload did not recover it,
because a reload is just another mount.

The arming gate is removed rather than re-derived on mount. `useRunningSubagents`
already excludes any card carrying a `subagentDurationMs`, and since cause A that
field is published only for a sub-agent whose own transcript has settled — so the
candidate list is already a disk-derived liveness verdict that survives a remount,
and re-checking it against the parent's streaming state could only drop live
sub-agents. Opening a finished chat still fetches nothing.
