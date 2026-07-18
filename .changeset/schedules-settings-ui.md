---
"@paddock/server": minor
"@paddock/web": minor
---

Per-project schedules management UI (#266).

Ticket D4 of the Events / Schedules / Config initiative — the Settings-pane surface
that completes scheduled chats. A new **Schedules** section in each project's
Settings tab lists that project's scheduled chats (name, cron/interval expression,
new-vs-accrete session mode, enabled state, live status + last/next run merged from
herdctl's runtime) and lets an operator create, edit, delete, enable/disable, and
**trigger now** — all wired to the D3 server surface (`ProjectStore.set/removeSchedule`
+ herdctl's `setAgentSchedule`/`removeAgentSchedule`/`enable/disableSchedule`).

- **New REST surface** under `/api/projects/:slug/schedules`: `GET` (declaration +
  runtime state + the `mutationEnabled` gate), `PUT :name` (create/replace), `DELETE
  :name`, `POST :name/(enable|disable)`, and `POST :name/trigger`. Each mutating
  route persists to `project.yaml` first (source of truth — re-arms on restart), then
  arms herdctl at runtime via the granular D3 APIs.
- **Trigger-now** fires the schedule through the SAME `startAgentTurn` hub path a
  cron fire uses (D3), so a manual run shows up as a first-class, discoverable,
  `scheduled`-badged chat (E1/#267) — never `isSidechain`-hidden. `makeChatHandler`
  now exposes its schedule-fire entrypoint so the route can reuse it; the cron and
  manual paths share one implementation.
- **Respects the per-deployment mutation gate** (`PADDOCK_SCHEDULE_MUTATION`, DD-7):
  when off, the mutating routes return 403 and the pane renders read-only with a
  hint, while listing and trigger-now (which runs an already-declared schedule)
  stay available.

Tests: integration against the real FleetManager + scheduler + CLI runtime (list /
create / edit / enable-disable / delete / trigger-now → a scheduled chat appears;
validation 400s; the gate-off 403 + read-only + still-triggerable case) plus web
component coverage of the Schedules section.
