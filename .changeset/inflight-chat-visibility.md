---
"@paddock/server": patch
"@paddock/web": patch
---

Show a new chat in the sidebar while its first turn is still running (#100).

A brand-new chat used to be invisible in the project sidebar until its first
keeper turn's `claude -p` process exited — herdctl writes a run's resolved
`session_id` into its job record only on completion, so mid-turn the session was
unattributed and filtered out of the session list. Long first turns were
unreachable from the UI for their whole duration, and navigating away lost the
chat entirely.

The server now attributes a new chat to its agent the moment its session id
first streams back (reusing the same synthetic job-record mechanism as
fork/promote), so `listSessions` includes it immediately. The web sidebar also
pulls the chat list when a session starts running that it hasn't listed yet, so
an in-flight chat surfaces live — even one started from another client/tab.
