---
"@paddock/server": patch
"@paddock/web": patch
---

Two client-side data-loss bugs are fixed: composer attachments riding an unrelated
message (#728), and a mid-turn remount silently discarding the assistant's reply
(#726).

**#728 — attachments were consumed by SENDING, never by QUEUEING.** A file staged
while a turn was in flight stayed in the tray: `send()` returned early into the
queue and never touched it, and the queue is flushed server-side, so the one piece
of code that consumes the tray never ran for a queued message. The file then went
out silently with whatever was sent next — a message the user never meant to
attach it to.

Attachments now travel with the queued message through the shared, server-owned
slot (#751/#629): `chat:set_queue` carries them, they merge into the slot as a
**union by id** (a write can only add, so a client re-asserting its queue after a
reload — tray long since empty — cannot wipe another device's file), every client
sees them on `chat:queued_state`, the drain sends them with the turn, and Stop
hands them back to the tray on `chat:queued_returned` alongside the text. A slot
may now hold files with no prose, so an attachment-only submit during a live turn
queues instead of being a silent no-op.

A pre-session chat's tray is also keyed per **new-chat instance** rather than per
project. `new:<slug>` was one key shared by every future new chat, so a file staged
on a chat the user abandoned came back pre-staged on the next one and rode its
first message; unlike a draft, whose text is visible, that is easy to miss. The key
still survives a reload (#346) and is rotated only by an explicit "New Chat".

**#726 — the REST transcript snapshot full-replaced live frames.** On remount
`ChatPane` cleared the transcript, fetched it, and applied the result wholesale.
The socket is attached future-only by design, so every frame arriving between the
server reading the transcript and the response landing was appended and then thrown
away — losing the assistant's entire reply and leaving a sub-agent card spinning on
"running" until a reload. The snapshot is now merged with what arrived during the
fetch (tools reconciled on `toolUseId`, assistant bubbles by prefix, everything else
by content), and is an unchanged full replace when nothing arrived — which is every
hydration on a fast connection.
