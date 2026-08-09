---
"@paddock/web": minor
---

**The fleet readout** (#784) — a strip above every route saying what the herd is
doing right now: how many turns are in flight fleet-wide, how many chats are
holding an unread reply, and one channel per running turn carrying its project, a
live elapsed clock and a segmented context gauge. Longest-running first, an
honest `+N` when more are running than fit, and clicking a channel opens that
chat.

Two of those did not exist anywhere in the UI before. A turn that had been going
forty minutes and one that started eight seconds ago looked identical, and
context pressure was visible only inside the chat it belonged to — by which point
you had already opened it.

**The only thing that animates is the clocks, because that is the only thing
changing.** A persistent readout is on screen 100% of the time, so anything
decorative in it is decorative forever.

It costs nothing at rest. The running set, the projects, and the clocks all come
from data the client already has — the existing `chat:active` frames and the
projects payload the sidebar is already using, which is also why the strip's
unread count and the sidebar's badges are one derivation rather than two that can
disagree. Only the chat's name and its context fill need a request, and that is
made only while a turn is actually in flight: an idle fleet issues none and arms
no timers.

Originally built as the signature element of a design direction that is not
shipping; the feature is orthogonal to the palette and inherits whatever theme is
active.
