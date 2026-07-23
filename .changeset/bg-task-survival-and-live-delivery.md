---
"@paddock/server": minor
---

Session-mode background work now survives an opening turn and streams its results live.

- **Survival on the first/opening turn.** A background task (`run_in_background` Bash, or a background `Task` sub-agent) launched on a fresh chat's first turn is no longer killed at the turn boundary. The fresh consume path used to end the turn with a `break` that tore down the underlying `claude` process; it now stops without closing and hands teardown to the reaper, which keeps a session alive while it holds live background work — matching the resume path.
- **Live delivery of autonomous re-invocations.** When a background task completes, the keeper's follow-up ("background command completed") turn now streams to the open chat with no refresh. Paddock keeps consuming the same session stream after the primary turn, which also keeps the runtime's background-lifecycle signals flowing.
- **Coherent background sub-agent rendering.** A background sub-agent's nested steps no longer spill into the transcript as top-level rows; the sub-agent renders as one card (its nested steps remain available on expand), consistent with the foreground and on-reload views.

Known limitation (tracked as a follow-up): while a background sub-agent is still running, its card shows a generic launch acknowledgement and only enriches to its real type, title, duration, cost, and expandable nested steps after a refresh.
