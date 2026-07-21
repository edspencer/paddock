---
"@paddock/server": minor
"@paddock/web": minor
---

Restore "Run now" + live run-status to the Triggers tab (#327). When Epic T folded the Settings→Schedules section into the unified Triggers tab, two capabilities were lost because `TriggerDto` carries trigger config only, not herdctl runtime state.

- **Run now** — `POST /api/projects/:slug/triggers/:name/run` fires any trigger on demand through the existing `fireTrigger` hub path (a first-class, badged run, regardless of the `enabled` flag), surfaced as a per-row action in the Triggers tab and as a `run_trigger` self-MCP verb.
- **Live status columns** — `GET /api/projects/:slug/triggers/runtime` joins herdctl job records (last-run, per the #268 run-history pattern) with the cron scheduler's `ScheduleInfo` (next-fire + status) into a per-trigger runtime DTO. The tab polls it to show each trigger's last-run / next-run / running-state.
