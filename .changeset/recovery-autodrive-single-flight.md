---
"@paddock/server": patch
---

Complete keeper-chat Layer 3 auto re-drive (#301/#352). Now that #350 fixed
detection (the turn-boundary task kill is recognised in its `queue-operation`
shape), the automatic re-drive fires reliably. Two double-dispatch guards ensure
the first injected nudge lands instead of being swallowed:

- The recovery engine stands down if a live turn is already driving the session
  when it goes to act (a human message, a queued-message drain, or a prior
  nudge) — resuming an in-flight session-mode `chatSession(resume)` interrupts
  and swallows the live turn (the "first message swallowed" symptom). No surface,
  no re-drive, and no retry is consumed; a fresh watch arms when that turn ends.
- `injectRecoveryNudge` (shared by the manual **Continue** button and the auto
  re-drive) is single-flight per session and yields to any in-flight turn, so two
  near-simultaneous dispatches can't both resume the same session.

The config surface is unchanged: `autoReDrive` (default OFF) + `debounceMs` +
`maxRetries` at instance level (`PADDOCK_RECOVERY_*`) with a per-project
`recovery` override, exactly like `driveMode`/`maxSpawnDepth`.
