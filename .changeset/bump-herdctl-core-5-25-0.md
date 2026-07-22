---
"@paddock/server": patch
---

Bump `@herdctl/core` to `^5.25.0`, which fixes the double-resume interrupt class at its source (herdctl#403/#404): `openChatSession(resume)` now consults `SessionReaper.isSessionLive` before spawning and defers a real resume until the session is reaped, instead of launching a second `claude` for an already-live session and self-interrupting. This is the fundamental fix that complements Paddock's own RecoveryEngine defer-and-retry guard (#397), and closes the whole class (auto-recovery, manual Continue, queued-drain, wake).
