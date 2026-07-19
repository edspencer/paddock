---
"@paddock/server": minor
"@paddock/web": minor
---

Add the unified **trigger** foundation (Epic T / T1): one discriminated `triggers`
config block — `schedule | event | webhook` (the **when**) + a shared `run` (the
**what**) + `enabled` — over the existing `startAgentTurn` execution core, collapsing
what were separate hook and schedule declarations into one model. Adds `TriggerService`
(the frozen CRUD registry T2–T5 build on) wiring **both** existing fire paths — the
lifecycle event bus (`onArchive`) and herdctl's schedule trigger handler — through a
single trigger fire path, plus a `TriggerSessionStore` sidecar that rebinds a
`run.session: "resume"` trigger's owned chat after a restart. New triggers default
`enabled: false`. No UI/REST/self-MCP surface yet (those are T3/T4); the webhook variant
is shape-reserved only (no ingress — T6).
