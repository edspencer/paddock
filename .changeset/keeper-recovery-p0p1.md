---
"@paddock/server": minor
"@paddock/web": minor
---

Configurable keeper-chat recovery — Phase 0 config + Layer 2 visibility/Continue (#301)

When a keeper starts a background task (background `Bash` or a background
`Task`/`Agent`) and ends its turn while it's still running, herdctl keeps the
session alive but the SDK/native binary kills the child at the turn boundary — the
`killed`/`stopped` `<task-notification>` emits no wake, so the keeper is left
alive-but-idle-forever (root cause: edspencer/herdctl#374). This adds an app-side
recovery mechanism.

**Phase 0 — config foundation.** A new `recovery` config group on `PaddockConfig`
(env `PADDOCK_RECOVERY_*`, YAML instance file, built-in defaults) plus an optional
per-project `recovery` override in `project.yaml` (tri-state update: object sets,
`null` clears, absent leaves untouched), resolved at dispatch (project ?? instance)
— the same discipline as `driveMode`/`maxSpawnDepth`:

- `surfaceKilledTask` — Layer 2, default **ON** (`PADDOCK_RECOVERY_SURFACE`)
- `autoReDrive` — Layer 3, default **OFF** (`PADDOCK_RECOVERY_AUTODRIVE`; the
  detection/inject engine is a follow-up — this ships only the flag)
- `debounceMs` (5000), `maxRetries` (1), `limboTimeoutMs` (0 = off)

**Phase 1 — Layer 2 visibility + manual Continue (default ON).** A killed/stopped
background-task notification now surfaces as a distinct amber "⚠ background task
terminated at the turn boundary — the keeper is idle" affordance (no longer folded
away), with a one-click **Continue** that injects a recovery nudge into the still-
alive session via `startAgentTurn` (new `chat:continue` WS action). The nudge is
attributed to a new `recovery` message sender and tells the keeper its task was
KILLED AT THE TURN BOUNDARY (not "stopped by user", cf #216) so it re-runs in the
foreground or reports.

Layer 3 automatic recovery is a follow-up.
