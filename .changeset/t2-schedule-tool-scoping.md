---
"@paddock/server": minor
"@paddock/web": minor
---

Per-trigger tool allow-list for **schedule** triggers (Epic T / T2, #307). A
schedule-type trigger that declares a non-empty `run.tools` allow-list now runs on
its OWN scoped `trigger-<slug>-<name>` agent — herdctl's `allowed_tools` /
`permission_mode` / `max_turns` enforce the capability by construction, exactly as an
event trigger already does. A schedule with no `tools` keeps running as the keeper with
the project-agent default toolset (pre-T2 behaviour, unchanged). The keeper's forwarded
`schedules` block remains the cron **timing** only; execution moves to the scoped agent.
`run.maxSpawnDepth` on a schedule now gates its fired turn's self-MCP spawn capability
(reuses B1). One shared `triggerRunsOnOwnAgent` predicate makes the arming and fire
paths agree on the keeper-vs-own-agent routing decision.
