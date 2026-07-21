---
"@paddock/server": patch
---

Fix RunProvenance mislabelling a human chat as "scheduled" (#353). A session
wake is a *resume*, not a *creation*: `onSessionWake` fires when a
`ScheduleWakeup`/`/loop` resumes an already-existing chat, and it never creates
one. It was stamping `stampIfAbsent(SCHEDULED_ROOT)`, which was correct only for
chats that already carried a creation stamp — but a chat that predates
provenance stamping (empty slot) and later arms a `ScheduleWakeup` would get
falsely labelled `scheduled` on its first wake, badging a human-rooted chat as a
cron root.

The wake path no longer stamps a creation origin at all. Genuinely
schedule-*created* chats are already stamped `scheduled` at creation
(`fireTriggerForProject` → `startAgentTurn`), so nothing is lost for them;
legacy/blank chats now stay unbadged (the correct outcome for a human chat)
instead of mislabelled.
