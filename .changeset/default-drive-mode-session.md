---
"@paddock/server": minor
"@paddock/web": minor
---

Switch the built-in default keeper drive mode from `batch` to `session` (#316).

A fresh/un-configured instance now drives keeper turns through the persistent
`openChatSession` (SDK runtime) by default, so cross-turn autonomy
(`ScheduleWakeup`, `/loop`, reaper-backed background work) and SDK streaming work
out of the box — instead of only when an operator sets
`PADDOCK_KEEPER_DRIVE_MODE=session`. The env var and per-project `driveMode`
override still take precedence; set `PADDOCK_KEEPER_DRIVE_MODE=batch` for the
legacy one-shot `trigger()` path.

Test hermeticity: the integration harness (fake `claude` on PATH, CLI-runtime
only) now explicitly pins `PADDOCK_KEEPER_DRIVE_MODE=batch` rather than relying on
the built-in default, so flipping the default doesn't route token-less test turns
through the SDK runtime ("Not logged in"). Config docs updated.
