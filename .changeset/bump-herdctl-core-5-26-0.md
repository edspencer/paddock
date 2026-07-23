---
"@paddock/server": patch
---

Bump `@herdctl/core` to 5.26.0, picking up herdctl #406/#407: the SessionReaper now defers its turn-end reap when a session is resumed with a prompt, so a replayed backlog turn on resume can no longer reap the resumed human turn out from under it (the `[Request interrupted by user]` self-interrupt).
