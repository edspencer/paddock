---
"@paddock/server": patch
---

Require `@herdctl/core` >= 5.27.0, whose `listJobs` is index-backed
(herdctl#415/#416). Core previously read and Zod-validated every `job-*.yaml`
sequentially and applied `filter.agent` only afterwards; it now filters, sorts
and pages against an incremental mtime-keyed index and fully parses only the
records it returns.

Measured on this instance's 1,996-record jobs directory, warm:
`GET /api/projects/:slug/runs` **1.47 s -> 0.15 s** (10x).

Note `GET /api/projects/:slug/triggers/runtime` is NOT improved by this bump
(1.28 s -> 1.12 s): `listRunsForAgents` calls `listJobs` with no filter and no
limit, so nothing is pushed down for the index to exploit. Core exposes only a
single-`agent` filter, so that path needs a separate Paddock-side change.
