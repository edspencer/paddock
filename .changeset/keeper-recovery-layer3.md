---
"@paddock/server": minor
---

Keeper-chat recovery — Layer 3 automatic re-drive (#301)

Builds on the Phase 0 config + Layer 2 manual Continue: a keeper whose background
task is killed at the turn boundary (edspencer/herdctl#374) now recovers **without a
human**, when `autoReDrive` is enabled (still default OFF).

A new post-turn detection engine (`packages/server/src/recovery.ts`) tails a
session-mode keeper's transcript after each turn. The hung signature — a terminated
(`killed`/`stopped`) `<task-notification>` with no keeper reply after it — triggers
the same recovery nudge the manual **Continue** button injects
(`startAgentTurn` + `RECOVERY_NUDGE` + `recovery` sender), so the keeper wakes on its
own and carries on.

Guards prevent misfires and loops: it only fires when the resolved `autoReDrive` is
on (per-project override else instance default); a `debounceMs` quiet window means a
keeper that wakes itself is never poked; a per-session `maxRetries` cap stops a
permanently-wedged keeper from being poked forever; and a human message resets the
session's guard so a genuinely-new later hang recovers fresh.

Enable instance-wide with `PADDOCK_RECOVERY_AUTODRIVE=1`, or per project via the
`recovery.autoReDrive` override in `project.yaml`. The `limboTimeoutMs` backstop timer
remains a follow-up.
