---
"@paddock/server": patch
"@paddock/web": patch
---

An explicit "mark unread" now survives a turn landing in the focused chat (#608)

Marking the open chat unread and having its in-flight turn complete a moment
later silently discarded the flag. The web client marks the focused chat seen
when a turn finishes there ("you were watching it"), and `POST .../seen` clears
the manual unread override — so an inferred seen quietly overrode an explicit
intent. The same happened via the API: `POST .../chats/:id/unread` returned
`{ ok: true }` and the write was then undone by a browser sitting in that chat,
with nothing telling the caller.

`POST .../chats/:id/seen` now accepts `keepUnread: true`, which advances the
last-seen watermark **without** clearing the manual override, and its response
carries the override's resulting state (`{ ok, lastSeen, unread }`). The web
client passes it only on the turn-completed-while-focused path; opening a chat
and the explicit read/unread toggle still spend the flag exactly as before.
