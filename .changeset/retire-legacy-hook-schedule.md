---
"@paddock/server": patch
"@paddock/web": patch
---

Retire the legacy hook/schedule REST + web-client dead code left behind additively
during the Epic T triggers migration. The Triggers tab, `/api/projects/:slug/triggers`
REST, and the `set/list/remove_trigger` MCP tools are now the only surfaces for standing
agent rules.

Removed: the pre-T3 `/hooks` and `/schedules` REST routes, `HookService`, the legacy
hook/schedule runtime dispatch + arming paths, the unused web api-client methods
(`listHooks`/`putHook`/`listSchedules`/…) and their DTO types, and the
`HookCapabilityBanner` (superseded by `TriggerCapabilityBanner`). The `project.yaml`
`hooks:`/`schedules:` block parser is kept for back-compat, alongside the shared
foundation the trigger system reuses (the reused hooks-MCP gate, the `hook` chat origin,
and the `.paddock/hooks/sweep.md` sweeper extension).
