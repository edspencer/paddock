---
"@paddock/server": minor
"@paddock/web": minor
---

Run-history "while you were away" view (#268).

Ticket E3 of the Events / Schedules / Config initiative — visibility for the runs
that happen when nobody is watching. A new project-level **History** tab lists
recent keeper runs with their **provenance** (human / scheduled / spawned), so the
unattended work (a cron-fired schedule, a chat spawned by another chat) is easy to
find, review, and open. Builds on the A1 provenance marker (#261 / DD-3), the E1
badges (#267), and D3 scheduled sessions (#265).

- **Data source.** `HerdctlService.listProjectRuns` reads herdctl job records via
  `@herdctl/core`'s `listJobs`, filtered to the project's keeper agent (so
  scratch/sweeper runs are excluded), newest-first. Each record carries timing
  (`started_at`/`finished_at`/`duration_seconds`), `status`, `session_id`, and the
  schedule/fork that triggered it.
- **Provenance join.** A new pure, unit-tested builder (`buildProjectRuns`) joins
  each run with the `RunProvenanceStore` marker keyed by `session_id`, so
  scheduled + spawned runs report their **true** origin and spawn depth.
  Paddock-initiated turns still persist `trigger_type:"manual"` on the job record,
  so origin lives in the provenance store, not the enum — the builder is the
  authoritative join.
- **"Since last login" digest.** `GET /api/projects/:slug/runs` folds in a
  per-user "runs last seen" watermark (reusing the `ReadStateStore` / #189
  read-state plumbing under a reserved sentinel session id), flags each run
  `isNew`, and counts new **unattended** runs. The History tab shows a count badge
  and a "N new runs ran while you were away" banner; opening the tab advances the
  watermark (`POST .../runs/seen`, monotonic).
- **UI.** `HistoryPane` matches Paddock's design system (provenance-colored origin
  chips, status chips, relative time + duration, schedule/parent trigger note),
  defaults to an "Unattended" filter with an "All" toggle, and links each run into
  its chat.
- **Cost is deferred (P3).** herdctl does not yet persist per-run token accounting
  (X1/#378 + X2/#271), so a documented cost seam (`RunSummary.cost`, always
  `null`; an em-dash column) is left where per-run cost will slot in without a wire
  change.

Note: session-mode turns (`openChatSession`) write no herdctl job record, so runs
driven that way don't appear here — only batch `trigger()` turns and the synthetic
adoption records do (a pre-existing, documented herdctl limitation, same as the
unread `lastTurnCompletedAt` signal).
