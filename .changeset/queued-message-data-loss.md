---
"@paddock/server": patch
"@paddock/web": patch
---

Three ways a queued message could be silently lost are fixed (#736, #629, #627).
All three live in the same handful of lines, so they are fixed together.

**A client with a fast clock no longer destroys every later queued message
(#736).** The drain's dedup marker was keyed on a *client-supplied* timestamp and
compared as an ORDERING — "older than the last flush, and timestamps being
monotonic, that can only be a stale re-assert". Timestamps are monotonic within
one client; this one came from whichever browser queued the message. So a laptop
five minutes fast parked the marker in the future, and every queued message on
that chat afterwards — from *any* client — was taken from the store, classified
already-flushed, deleted and never sent, with the chip cleared and no error, until
wall-clock time caught up. Confirmed in a real browser with `Date.now` shifted.

A queued message's identity is now an opaque id, compared only for equality, and
the enqueue time is stamped server-side. Nothing about clocks is assumed anywhere.
The `(id, text)` tuple from #628 is unchanged in behaviour: an append keeps its id
with longer text, so it is still a genuinely new message, and a reloaded client
re-asserting exactly what was already flushed is still recognised and cleared.

**A second client's queue merges into the chat's one slot instead of overwriting
it (#629).** The slot is one-per-chat and `set()` was a bare overwrite, so a
second tab (or a phone, or one stale tab left open) destroyed the first client's
message unrecoverably — no error, and the first client's chip went on showing a
message that no longer existed anywhere. Worse, when the drain fired, that
client's own transcript rendered the *other* client's text as a user bubble they
had never typed.

The queue is now shared chat state: a new `chat:queued_state` frame is broadcast
to every socket attached to the session whenever the slot changes, so all clients
render the same thing, and a client that queues without having seen what is
already there has its text appended rather than substituted for it. One slot, one
chip, nothing lost.

**A queued message escapes on every turn-ending path, not just `chat:send`
(#627).** `drainQueue` was called from exactly one of the eight `turn.end()`
sites. A message queued during `/compact` or any slash command, a trigger or
spawned turn, a scheduler wake, a background sub-agent stretch, or a turn the user
Stopped, was persisted and then stranded — escaping only when some *later*
`chat:send` completed, which put it in the transcript **behind** a message typed
minutes afterwards, with a stale chip sitting above the composer in between.

The drain now hangs off a turn-end hook on the session hub, which every one of
those paths already goes through, so this is structural rather than a list of call
sites to remember to extend. It also sits above the batch/session runtime split,
so both drive modes behave identically.

**Stop is the one exception, and it hands the message back rather than sending
it.** "Give me control back" and "start working again immediately" are opposites,
so the message queued behind a Stopped turn goes into the composer of the client
that pressed Stop — by the same path the queued bar's Edit button has always
used, so it merges with whatever was already typed and persists as an ordinary
draft. Other clients watching the chat see the shared slot clear with a reason
attached rather than a chip vanishing for no visible cause. If there is nobody
left to hand it to (the tab closed between the Stop and the turn ending), the
message stays queued and is parked so no later turn end sweeps it out behind
something typed afterwards — and a pane opening the chat is now told what is
queued on it, so a parked message is never invisible.

The destructive-op interlock (#731) is excluded too: it cancels a turn precisely
so it can delete, revert or promote the transcript, and starting a fresh turn
there would both race that and keep the session busy so the interlock could never
settle.

Also in the same area: a queued message is capped at 100,000 characters (a 2 MB
`chat:set_queue` used to be accepted and persisted verbatim, and the sidecar is
rewritten in full on every queue mutation), and the in-memory flushed-message
ledger is bounded per chat and per server.
