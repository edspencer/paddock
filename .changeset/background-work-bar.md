---
"@paddock/server": minor
"@paddock/web": minor
---

Show background work that is still running, pinned above the composer (#604)

A sub-agent already got a live row above the composer while it worked. Nothing
else did. A background `Bash`, a `Monitor`, or a workflow could run for minutes
behind a card scrolled far up the transcript, and the only hint was a static
`running` chip that meant "no completion notification was found in the
transcript" — not "we checked". A killed task kept that chip forever.

Worse, the chat itself claimed to be idle. `chat:active` reports one hub turn,
and a background task outlives the turn that launched it, so the moment the
reply landed every consumer of that signal — the sidebar streaming dot, the Home
in-flight badge, the running-only filter, the composer's own streaming state —
was told the session had stopped while minutes of work continued.

Both come from the same missing piece, and the Claude Agent SDK already
publishes it. `background_tasks_changed` carries the complete live task set on
every membership change, with `task_started` / `task_progress` /
`task_notification` adding per-task detail. herdctl already taps that stream to
decide session reaping; Paddock dropped it on the floor.

- **New `BackgroundRegistry`** (`background-live.ts`) folds those signals into a
  per-session live set, fed from all five turn paths. The level signal is the
  sole authority on membership and edges may only enrich, so a missed edge cannot
  wedge a stale row — the failure mode #528 was.
- **New `chat:background` frame**, broadcast on every change and replayed to a
  newly-connected socket, so a remount or reload is populated on the first paint
  instead of after a poll.
- **`chat:active.running` now accounts for background work**, which is the #604
  fix proper. Every consumer of the signal reads the truth.
- **`RunningSubagents` becomes `RunningWork`**, rendering shells, monitors and
  workflows alongside sub-agents, with elapsed time and live step counts. A task
  the transcript path already shows is not duplicated; ambient work the SDK marks
  `skip_transcript` is hidden.

The signal is per-process and emits nothing at startup, so after a server
restart the bar is empty until the next change. That is correct rather than a
gap: Paddock stops the fleet with `waitForJobs: false`, so those tasks are dead —
unlike the old chip, which went on claiming a killed task was alive.

Session drive mode only; the CLI runtime reads the transcript file, which these
stream-only control messages never reach.
