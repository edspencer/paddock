---
"@paddock/server": patch
---

Bump `@herdctl/core` to 5.26.1. Picks up two herdctl fixes: durable session wakes are now retired when the agent runs `CronDelete` (recurring `CronCreate`/`/loop` wakes are cancellable again instead of firing until the 7-day prune), and `tool_reference`-content tool results are preserved so ToolSearch cards no longer stick in a RUNNING state.
