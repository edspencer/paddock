---
"@paddock/server": minor
"@paddock/web": minor
---

Keeper cross-turn autonomy via a session drive-mode (#111). Keepers can now schedule a `ScheduleWakeup` / `/loop` and be re-invoked when it fires, instead of the work silently dying at the turn boundary.

- **`driveMode` per keeper turn** — `batch` (legacy one-shot `trigger()`) or `session` (a persistent, herdctl-managed `openChatSession` with `manageLifecycle: true`, so idle sessions are reaped and their timer-class wakeups re-fired by herdctl's scheduler — herdctl#307). Resolved global → project: `PADDOCK_KEEPER_DRIVE_MODE` env default (defaults to `batch`) overridden by a per-project `driveMode` setting. Consumes `@herdctl/core@5.18.0`.
- **Woken turns land in the chat** — a scheduler-fired wake runs with no client attached; its output is streamed onto the hub / transcript / attribution exactly like a human turn (client-less turns supported in the session hub).
- **Stop fix (both modes)** — the Stop button was a no-op whenever the model was still "thinking" (no content frame had yet carried the `jobId`), so the client had nothing to cancel. The hub now re-broadcasts `chat:active` the instant the `jobId` resolves, arming Stop immediately. Session-mode Stop maps to `session.interrupt()`; batch-mode Stop still aborts the job.
- Keeper `allowed_tools` now include the timer-class autonomy tools (`ScheduleWakeup`, `Monitor`, `Cron*`, `ToolSearch`), which the runtime previously auto-denied.
