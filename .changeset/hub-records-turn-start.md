---
"@paddock/server": patch
---

The session hub now records when each turn **started**, and puts it on the
`chat:active` frame as `startedAt`.

Nothing else in the system knows this. A herdctl job record is written when a
turn *ends*, and a transcript's timestamps are the model's rather than the run's
— so a client could previously only date a turn from the moment it happened to
see it. Because the server replays its whole running snapshot to every socket on
connect, a client that reloads mid-turn now still learns the true start instead
of restarting the clock at zero on every page load.

Optional on the wire, so a client built against an older server still parses the
frame.
