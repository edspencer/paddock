---
"@paddock/server": minor
---

Bump `@herdctl/chat` `^0.4.8` → `^0.5.5` so `@herdctl/core` resolves to a single hoisted `5.19.1` (was split: a stale `5.15.1` hoisted by chat's exact pin, `5.19.1` nested under the server) and `@anthropic-ai/claude-agent-sdk` resolves to `0.3.x` (was `0.1.77`) (#182). This actually delivers what session drive-mode promises on-box: the herdctl#303 native agentic toolset (`ScheduleWakeup`, `Cron*`, `Monitor`, background tasks) in the `openChatSession` harness, and the herdctl#307 session-lifecycle reaper that keeps a streaming session alive while `background_tasks` is non-empty (so a detached background subagent survives the turn boundary — #180) and re-fires `ScheduleWakeup`/`/loop` via the scheduler.

Also makes the server integration suite hermetic to the box's `PADDOCK_KEEPER_DRIVE_MODE` env: the test harness now forces the default batch/CLI-runtime path so the fake-`claude` fixture is exercised regardless of a `session` value in the ambient environment (which would otherwise route turns through the SDK runtime and fail with "Not logged in" in a token-less CI/test env).
