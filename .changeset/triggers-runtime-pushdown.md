---
"@paddock/server": patch
---

Stop the Triggers tab re-parsing the whole fleet-wide jobs directory every 10
seconds.

`listRunsForAgents` — the data source behind the per-trigger last-run column —
called core's `listJobs(jobsDir)` with **neither a filter nor a limit**, then
filtered to the agents it wanted and sliced in JS. That defeats core's job index
completely: with `filter.limit === undefined` core sets `retain = matches`, so
every record in the shared, never-pruned, fleet-wide jobs directory is read,
YAML-parsed and Zod-validated on every call, then thrown away.

It was written that way for a reason — `ListJobsFilter` had `agent` (exactly
one) and no multi-agent form, and this route needs a project's agent *plus*
every scoped `trigger-<slug>-<name>` agent. herdctl#418 adds `agents?: string[]`,
so the filter can now be pushed down where the index can use it.

Measured against a 2,016-record jobs directory, three calls per process after
the index is warm:

| | call 1 (cold index) | call 2 | call 3 |
|---|---|---|---|
| before | 1,226 ms | 1,047 ms | 1,081 ms |
| after | 1,245 ms | **83 ms** | **69 ms** |

**~16× warm.** The old shape never warmed at all — that is the point: it paid
full price on every request, and `GET /api/projects/:slug/triggers/runtime` is
polled every 10 seconds while the Triggers tab is open.

Both `agents` and `limit` are load-bearing. `agents` alone still leaves `limit`
undefined, so `retain = matches` and every match is hydrated anyway; the win
comes from the pair.

**Order is the thing at risk here, not just membership** — the old shape sorted
the entire directory and then filtered, the new one filters first and lets core
sort the survivors. So the regression test diffs the new call against a literal
reimplementation of the old one, over records deliberately interleaved across
agents and timestamps so that any per-agent grouping would reorder the result.
Those tests fail against a core older than 5.28.0, which is the intended signal:
this needs `@herdctl/core` >= 5.28.0 (the dependency floor is already `^5.31.0`)
rather than re-filtering defensively in Paddock, which would mask a version
mismatch instead of surfacing it.

The pre-existing "a chatty agent can push a rarely-run trigger out of the 200
window" behaviour is preserved exactly — the limit still applies after filtering
to the requested agents. Neither caused nor fixed here.
