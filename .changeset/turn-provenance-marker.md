---
"@paddock/server": minor
---

Thread an origin + spawn-depth provenance marker through non-human turn injection (#261).

This is the foundation (ticket A1) for the Events / Schedules / Config initiative.
Server-initiated turns — `startAgentTurn` (the self-MCP write tools' spawn path) and
the `onSessionWake` handler — now carry an `origin` (`human` / `scheduled` / `spawned`)
plus a spawn `depth`, and each chat's marker is persisted to a new per-chat sidecar
(`run-provenance.json`, following the ArchiveStore / ReadStateStore pattern):

- a human-started chat → `origin: human, depth: 0` (the root of any spawn tree);
- a chat spawned by a self-MCP write tool (`create_chat` / `fork_chat` / …) →
  `origin: spawned, depth: parent.depth + 1`;
- a scheduler-fired wake → `origin: scheduled, depth: 0` (stamped only if the chat
  has no marker yet, so a resume/wake never clobbers an existing chat's provenance).

Provenance is recorded once, at chat creation, and is never overwritten by a later
turn on that chat. This carries and persists the marker only — **no behaviour changes
yet**: spawned children are still injected with `send_file` only (no self-MCP), exactly
as before. Depth-gated spawn capability (#262) and provenance badges (#267) build on
this marker.
