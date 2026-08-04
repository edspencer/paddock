---
"@paddock/server": patch
---

Stop destroying appended queued text when the enqueue timestamp is reused (#628)

The server's queue drain deduped a queued message on its client-supplied
`createdAtMs` alone. The client deliberately KEEPS that timestamp when appending
to an existing queue, so the message identity stays stable (#245) — which meant a
pane holding an already-drained queue (it never saw the un-buffered
`chat:queued_flushed` clear) re-asserted the same timestamp with longer text, and
the next drain treated it as a duplicate: it broadcast a text-less clear and threw
the appended text away. Not delayed — gone.

Drain now dedups on the `(ts, text)` tuple. A re-assert of the exact same message
is still a duplicate (so #245's no-double-send guarantee is unchanged), but "same
ts, different text" is correctly recognised as a new message and sent.
