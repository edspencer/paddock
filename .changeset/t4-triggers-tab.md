---
"@paddock/server": minor
"@paddock/web": minor
---

T4 (Epic T "Unify Triggers"): the per-project **Hooks tab** is renamed and generalized
into a **Triggers tab**, and the **Settings → Schedules** section is folded into it. One
list now manages every trigger type — each row shows a `trigger.type` badge (schedule /
event / webhook), its firing condition, a capability summary, and an enabled toggle — all
over the unified `/api/projects/:slug/triggers` REST surface (T3). Creating/editing a
trigger uses a discriminated form (schedule → cron/interval, event → the served `on`
picker, webhook → shown but reserved). The in-chat capability banner is generalized to
trigger chats, stating the trigger type, its firing condition, granted tools, permission
mode, model, and max-turn limits (a new `trigger-<slug>-<name>` chat descriptor served on
the chat DTO). The legacy `/hooks` route redirects to `/triggers`.
