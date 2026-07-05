---
"@paddock/server": minor
"@paddock/web": minor
---

Chat streams now survive a mid-turn socket drop (#54). A turn's frames were bound
to the single socket that started it and silently dropped whenever it wasn't
`OPEN`, so an idle/half-open drop (sleep, wifi change, tab suspend, the client's
own reconnect) stalled the live stream until a manual reload.

The server now tracks each session's in-flight turn in a `SessionHub` with a
bounded, seq-numbered frame buffer and fans frames out to whichever socket(s) are
attached — not just the origin. A new `chat:subscribe` message lets a
reconnecting client re-attach to a running turn and replay exactly the frames it
missed (by `seq`), so the stream resumes seamlessly with no gap and no
duplication. A just-completed turn's buffer lingers briefly so an end-of-turn
reconnect still receives the terminal frame; if the missed gap has aged out of
the buffer the server sends `chat:resync` and the client re-hydrates from the
transcript.
