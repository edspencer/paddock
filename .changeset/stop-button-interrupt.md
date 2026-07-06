---
"@paddock/server": patch
---

Make the chat **Stop** button actually interrupt a running turn. The stop path
calls `cancelJob`, which previously only rewrote the job's status file while the
agent kept running — so nothing stopped and the composer stayed locked. Bumping
`@herdctl/core` to the release that fixes `cancelJob` (it now aborts the live
run) means a cancel genuinely kills the turn; `trigger()` then returns and the
server emits the terminal `chat:complete`, so the UI unlocks.
