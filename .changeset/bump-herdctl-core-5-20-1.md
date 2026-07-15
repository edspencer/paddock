---
"@paddock/server": patch
---

chore(deps): bump @herdctl/core ^5.20.0 → ^5.20.1

Picks up the session-reaper fix from [herdctl#368](https://github.com/edspencer/herdctl/issues/368) / [herdctl#369](https://github.com/edspencer/herdctl/pull/369): an asynchronous background task's completion no longer reaps the managed session out from under the SDK's re-invocation turn. This fixes keepers "stopping" the instant a `run_in_background` task (a CI-watch loop, a background Explore/research agent, a long build) finishes — the re-invocation that delivers the task's result now survives, so autonomous cross-turn work in session drive-mode completes instead of silently stalling.
