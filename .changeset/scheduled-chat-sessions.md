---
"@paddock/server": minor
---

Scheduled chat sessions, server side (#265).

Ticket D3 of the Events / Schedules / Config initiative — the headline feature: a
chat triggered by cron instead of by a human. A scheduled agent is just a normal
Paddock chat that a schedule started, so a human can open it and continue the
conversation afterward. Built on the A1 provenance marker (#261) and
`@herdctl/core@5.21.0`'s new scheduling seam + runtime-mutation APIs (#375/#376).

- **`project.yaml` `schedules`.** A project declares schedules in herdctl's own
  `ScheduleSchema` shape (`type: cron|interval`, `cron`, `interval`, `prompt`,
  `enabled`, `resume_session`), forwarded **unmolested** into the keeper agent's
  `schedules` block at `addAgent` time — herdctl's cron engine arms them directly,
  no parallel Paddock schema, no translation. Malformed entries are dropped (not
  thrown) so a bad hand-edit can't brick keeper registration.
- **Trigger seam → the hub.** Paddock registers a `scheduleTriggerHandler` via
  `FleetManager.setScheduleTriggerHandler`, so a fired schedule runs on Paddock's
  OWN hub through `startAgentTurn` with **`origin: scheduled`** (depth 0). The run
  is a first-class chat: it streams live, drives the sidebar dot, is re-attachable,
  and is NEVER `isSidechain`-hidden (we bypass herdctl's headless `--resume`).
- **`resume_session` new-vs-accrete.** `false` → a fresh chat each fire
  (`resume: null`); `true` → resume the schedule's ONE **owned session**, created
  on the first fire and reused thereafter — persisted in a `schedule →
  ownedSessionId` sidecar (`ScheduleSessionStore`, the `ArchiveStore` /
  `RunProvenanceStore` pattern, including the in-flight-load-promise fix). A stale
  owned id whose transcript vanished is dropped so the next fire re-creates one.
- **`promptFile` sugar.** A schedule may point at a git-tracked, keeper-editable
  `.paddock/schedules/*.md` file; Paddock reads it FRESH at fire time and forwards
  a plain `prompt` string, so an edit takes effect on the next fire with no
  re-register. The file indirection is stripped before forwarding — the herdctl
  config stays pure. Path traversal outside `.paddock/schedules/` and non-`.md`
  names are rejected.
- **Runtime mutation plumbing.** `HerdctlService.setAgentSchedule` /
  `removeAgentSchedule` (for the future D4 UI) and `ProjectStore.setSchedule` /
  `removeSchedule` persistence, behind a per-deployment gate
  (`PADDOCK_SCHEDULE_MUTATION`, default OFF → the FleetManager is constructed with
  `allowScheduleMutation: false` and the mutation APIs throw). Declaring schedules
  statically in `project.yaml` is unaffected by the gate.

Bumps `@herdctl/core` to `^5.21.0`.
