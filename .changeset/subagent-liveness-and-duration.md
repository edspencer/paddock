---
"@paddock/web": patch
---

A sub-agent's own transcript now decides whether it is running, and what its
duration is — not the parent's turn.

Two visible bugs, one root cause. The SDK **backgrounds sub-agents by default**,
so the parent routinely finishes its reply while they keep working. Both the
"running" state and the displayed duration were derived from the parent instead
of the sub-agent.

**The bar vanished the moment the parent replied.** Liveness hung off the chat's
`streaming` flag. Captured frame timeline for a turn that launches two research
sub-agents and then answers:

```
 13.5s  chat:tool_call   Agent  durationMs=38     ← launch-ack
 22.6s  chat:complete                             ← both sub-agents still working
 22.6s  chat:active      running=false            ← client sets streaming=false
 34.9s  chat:active      running=true             ← background stream reopens
```

For those ~12 seconds the chat looked idle: the running-sub-agents bar
disappeared and every card snapped from "RUNNING" to a finished state, while the
work carried on for another six minutes.

**Cards advertised the launch-ack as the runtime.** `durationMs` on the launching
`Task`/`Agent` call is the time to *spawn* a background sub-agent (~30ms), not the
time it ran. A four-minute research sub-agent displayed "38ms" until a reload
replaced it via the history join.

Liveness and duration now come from the sub-agent's own transcript, which the
running-sub-agents bar already polls:

- a sub-agent stays "running" while its transcript grows, and only settles after
  6 silent polls (~12s) once the chat is no longer live — so it survives the
  parent's `chat:complete`;
- duration prefers the server's final figure, else the transcript's first→last
  span, else **shows nothing**. An honest gap beats a wrong number, and the
  launch-ack is never used for a sub-agent card.

Polling is armed only for sub-agents seen while the chat was live, so reopening a
finished chat still fetches nothing until you expand a card (the lazy-load
contract), and it stops entirely once everything has settled.

Verified live: bar continuously present 9s→393s across the parent's completion,
zero samples of a hidden bar while a card read RUNNING, and final durations of
4m 34s / 5m 55s instead of ~30ms.

Known limitation, deliberately left visible: a sub-agent that goes completely
silent for >12s while the parent is idle settles early and drops out of the bar
(its card keeps the elapsed time it reached). The robust fix is server-side —
`chat:active` should not report `running: false` while background sub-agents are
still in flight.
