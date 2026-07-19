---
"@paddock/server": minor
---

Collapse the paired hook + schedule verbs onto the unified **triggers** surface
(Epic T / T3), building on the T1 `TriggerService`:

- **REST**: `GET/PUT/DELETE /api/projects/:slug/triggers[/:name]`. The list `GET`
  serves the capability-picker catalog (the `GRANTABLE_TOOLS` tool list, the known
  event values, and the trigger types). `PUT` is a full-replace create/update;
  enable/disable is just `set` with `enabled` flipped (no separate verb). All changes
  persist to `project.yaml`'s single `triggers` block and arm herdctl (an event
  trigger's own `trigger-<slug>-<name>` agent, a schedule trigger's forwarded
  `schedules` entry).
- **Self-MCP**: the `set_hook`/`set_schedule` (+ `list_*`/`remove_*`) verbs are
  replaced by unified `set_trigger` / `list_triggers` / `remove_trigger`, carrying the
  discriminated `trigger` (`schedule | event | webhook`) + shared `run` + `enabled`.
  `set_trigger` is a partial patch (an `enabled`-only call just flips the toggle;
  supplying `prompt` clears an inherited `promptFile` and vice-versa). The tools are
  gated by the reused per-project trigger-MCP opt-in (absent when off).

The legacy `hooks:`/`schedules:` REST + config blocks remain additively until the
Triggers tab (T4) migrates the UI off them.
