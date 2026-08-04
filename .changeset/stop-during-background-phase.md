---
"@paddock/server": patch
---

Fix Stop being a permanent no-op while a chat runs background work (#528)

A chat could sit with the spinner and the **Stop** button showing forever. Stop
did nothing — no error, no frame, no log line. The composer silently queued
anything typed instead of sending it, and reloading didn't help because the state
is server-authoritative and replays as running. Only restarting the server
cleared it.

Two independent things had to be wrong at once, and both were.

**The turn had no cancellable identity.** Once a session-mode turn's primary
`result` lands, the session can stay open — the reaper holds it while the turn's
background work runs — and autonomous re-invocation turns keep arriving on the
same stream. Paddock renders that stretch through `makeBackgroundTurnSink`, which
opened its hub turn and never called `setJobId`. `setJobId` was being called at
only two of the five turn-start sites, and this was one of the three that missed,
so every frame and every `chat:active` carried `jobId: null`. The client's
deferred-cancel (#196) waits for a jobId that never arrives, so clicking Stop put
**nothing on the wire at all** — which is why it failed silently rather than
erroring. The sink now mints a synthetic job id and publishes it the moment the
turn opens, exactly as the foreground path does via `onJobCreated`.

**Nothing it could route to.** `HerdctlService.cancel` knew two kinds of id: a
live turn in `liveSessions` (→ `session.interrupt()`) and a batch job (→
`cancelJob`). The primary turn's `liveSessions` entry is deleted the moment it
returns, so a background-phase id matched neither and fell through to
`cancelJob(<synthetic uuid>)` → `JobNotFoundError` → `false`, discarded by the WS
layer. `interrupt()` would have been wrong anyway: it targets an in-flight model
turn, and this session is idle, holding background work. Cancel now routes these
to `fleet.reapChatSession()` (new in `@herdctl/core` 5.31.0) — end the session,
let the stream end, and let the existing unwind emit `chat:complete` and unlock
the UI.

The wedge is easiest to hit on a **subscription usage limit**: sub-agents die, the
parent's re-invocation turn dies without a Stop hook, and the reaper's
`awaitingTasks` state (cleared by that turn's `activity`) means no later signal
can ever reap the session. It also covers the originally reported trigger — a
model-authored `until` loop whose sentinel never arrives, so the background task
set never drains.

Requires `@herdctl/core` ≥ 5.31.0.
