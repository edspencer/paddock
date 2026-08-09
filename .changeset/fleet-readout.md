---
"@paddock/server": patch
"@paddock/web": minor
---

A **fleet readout** across the top of every route (#784): fleet-wide `RUNNING` and
`UNREAD` counts, plus one channel per in-flight turn showing its project, a live
elapsed clock, and a segmented context gauge. Longest-running first, with an
honest `+N` when more turns are running than fit the width; clicking a channel
opens that chat.

Two of the five things it reports did not exist anywhere in the UI before. A turn
forty minutes deep and a turn eight seconds old looked identical, and context
pressure was visible only *inside* the chat it belonged to — by which point you
had already opened it.

Two server changes make it honest rather than decorative:

- **The session hub records when a turn started** and puts it on the `chat:active`
  frame. The hub is the only thing that knows: a job record is written when a turn
  *ends*, and a transcript's timestamps are the model's rather than the run's.
  Because the server replays its whole running snapshot to every socket on
  connect, a client that reloads mid-turn learns the true age of each turn instead
  of restarting every clock at zero.
- **`GET <workspace>/chats/attention` now resolves usage for RUNNING rows**, so a
  live context gauge has something to draw. Deliberately only for running rows:
  resolving usage streams a transcript per chat and that route sweeps a whole
  subtree's history, so the cost stays proportional to live work rather than to
  how many chats an instance holds.

**It costs nothing while the fleet is idle.** The counts come from data the app
already has — the WebSocket's fleet-wide running map, and the same fold over the
projects payload that draws the sidebar's unread badges — so an idle readout
issues no request and schedules no timer. The one fetch, for per-chat names and
context fills, runs only while at least one turn is running and only while the tab
is visible. The channels themselves are derived from the socket rather than from
that fetch, so a slow or failed request degrades a channel to a project and a
clock, never to a fleet that looks idle.

The strip keeps a fixed height whether or not anything is running. It sits above
every route including an open chat transcript, and the trigger would be a *fleet*
event — some other agent, in some other project, starting a turn — so collapsing
it away would reflow whatever you were reading because something happened
elsewhere.
