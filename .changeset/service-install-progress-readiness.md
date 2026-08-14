---
"@paddock/server": patch
---

`paddock service install` no longer sits silent for several seconds and then
dumps the whole success block at once (#861). It now names each stage as it
starts it — writing the unit and starting Paddock (with macOS's
background-item approval called out, since that is most of the pause and is out
of our hands), then waiting for the URL.

That wait is also what makes the last line true. "running now" used to be
printed unconditionally, before anything had been checked, so it could sit over
a service that was crash-looping on a port clash — a state both supervisors
report as running for most of the interval between restarts. Install now waits
for `/api/health` to answer before claiming success, and says plainly that the
unit is in place but the URL did not answer when it does not.
