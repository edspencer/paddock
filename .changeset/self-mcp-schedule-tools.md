---
"@paddock/server": minor
---

Self-MCP schedule management tools: `set_schedule` / `remove_schedule` / `list_schedules` (#289).

A keeper can now define and manage its project's durable schedules programmatically
via the self-management MCP — not just a human through the Settings UI. This is the
natural next step for the manager-agent pattern ("schedule yourself to triage issues
every morning"). Distinct from the ephemeral, session-scoped `ScheduleWakeup`: these
tools persist the schedule in project config so it fires even when nobody is watching,
with each fire appearing as a new chat carrying the `scheduled` badge.

The three tools are exposed as **write** tools (present only when `selfMcpWriteEnabled`
is on and the chat is within `maxSpawnDepth`), and simply surface the existing D3/D4
server side — `ProjectStore.set/removeSchedule` (the `project.yaml` source of truth) +
`HerdctlService.set/removeAgentSchedule` (live arming) — the exact two-step the REST
routes use (persist first, then arm best-effort).

- **`set_schedule`** — create or update a schedule by name, in herdctl's
  `ScheduleSchema` shape: `type` (`cron` with a 5-field `cron` expression, or
  `interval` with a duration like `30m`/`1h`), `prompt` (inline) or `prompt_file`
  (a `.md` under the project's `.paddock/schedules/` dir, read at fire time),
  `resume_session` (fresh chat each fire vs. accreting into one owned session), and
  `enabled`.
- **`remove_schedule`** — delete a schedule by name (safe when absent).
- **`list_schedules`** — read a project's schedules (declaration + live runtime
  state: status, last/next run, last error).

`set_schedule` / `remove_schedule` honor DD-7's per-deployment schedule-mutation gate,
refusing with a clear message when it's off; `list_schedules` is read-only and
unaffected — mirroring the REST routes (PUT/DELETE gated, GET open).
