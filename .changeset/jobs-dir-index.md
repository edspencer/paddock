---
"@paddock/server": patch
---

Cache the jobs-dir scan behind the unread badge (#529). `lastTurnCompletedAt` /
`lastTurnCompletedAtByProject` used to `readdir` + `YAML.parse` **every**
`job-*.yaml` on every `/api/projects`, `/api/projects/:slug` and `/chats`
request. On a real instance (1,996 records, 46.6 MB) a CPU profile put **61% of
all busy server CPU** in that one parse; because it is synchronous work on the
single event loop it pinned throughput at ~1.1 req/s and made an unrelated 2 ms
endpoint take ~0.9 s while a scan was in flight.

Both now read through a new `JobsDirIndex`, which keeps one entry per record
keyed on `mtimeMs` + `size`, so a warm scan only parses files it has never seen —
and is warmed at boot so the first page load doesn't pay for the cold pass. A
record is only cached once it has a `finished_at`: that is the point at which it
becomes immutable, so a still-running turn can never be memoized as final.
Behaviour is unchanged — same `session_id → max(finished_at)` mapping, same
per-project grouping, same skip-never-throw on a corrupt record; verified by
diffing every one of 281 `chatTurns` rows and 284 per-chat timestamps against
the old build on the same corpus.

Measured on that corpus: `GET /api/projects` 0.86 s → **0.036 s**,
`/api/projects/:slug/chats` 0.92 s → **0.086 s**, the projects grid's seven
parallel `/chats` calls 6.19 s → **0.13 s**, throughput at 8 concurrent
1.06 → **18.5 req/s**, head-of-line blocking of `/overview` 0.89 s → **0.04 s**,
and in-browser LCP on a project page 2.31 s → **0.33 s**.
