---
"@paddock/server": patch
"@paddock/web": patch
---

Fix keeper auto-recovery firing a competing resume that self-interrupts (issue
#397). Layer-3 auto re-drive (#301/#352) detected a killed-at-turn-boundary hang
and injected the recovery nudge while herdctl's `SessionReaper` was still keeping
the original `claude` subprocess alive (keepAlive + its ~15s re-invocation grace).
Because Paddock drives every session-mode turn as a fresh `openChatSession(resume)`
= a NEW subprocess, the re-drive spawned a second `claude` on the same session id;
the SDK resolved the collision by interrupting the in-flight turn (`[Request
interrupted by user]`), so the auto-recovery turn produced nothing and the user was
still stuck. The #352 stand-down guard only checked `hub.isRunning`, which is blind
to a reaper-kept-alive subprocess.

The recovery engine now consults the reaper's true liveness
(`getSessionLifecycle()?.reaper.isSessionLive`, null-safe) alongside `hub.isRunning`,
and — rather than standing down permanently (which left recovery incomplete, since
the reaper reaps silently and nothing re-arms) — DEFERS: it re-checks on a settle
poll and fires the nudge exactly once the session is genuinely idle, bounded by a
settle window so a session that never releases can't retry forever. Pairs with the
herdctl-side class-fix (herdctl#403: `openChatSession` should guard on
`isSessionLive` before spawning a second subprocess).
