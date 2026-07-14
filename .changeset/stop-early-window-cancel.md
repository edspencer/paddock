---
"@paddock/web": patch
---

fix(web): Stop button is a silent no-op when clicked in the pre-arm window (#196)

The composer flips Send → Stop the instant a turn starts streaming, but the
client could only send `chat:cancel` once it knew the turn's `jobId` — which the
server round-trips a beat later (via the first frame / `chat:active`). Clicking
Stop in that gap silently did nothing: no cancel was sent and the turn ran to
completion. The window is usually 1–5s but can stretch to ~12s on a new chat's
first turn under load.

Now a Stop clicked before the jobId is known is *deferred*: the intent is
remembered and the cancel fires the instant the jobId arrives. Also nulls
`jobRef` at the start of every turn so a Stop in turn 2+'s pre-arm window can't
fire `chat:cancel` against the previous turn's already-finished job id (a
server-side no-op that left the new turn running).
