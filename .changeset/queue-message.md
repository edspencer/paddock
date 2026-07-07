---
"@paddock/web": minor
---

feat: queue a message to auto-send when the current turn finishes (#91)

While the agent is streaming a turn, the composer no longer no-ops on
Enter/Send — it **queues** a single follow-up message that fires automatically
the moment the turn completes. A slim toolbar directly above the composer shows
the queued message (first line) with a "queued" indicator; hovering reveals
**Edit** (pops it back into the composer, cancelling the pending auto-send) and
**Clear** (discards it). Mirrors Claude Code's model: exactly one queued message,
and re-submitting while one is queued **appends** to it rather than stacking a
second.

Semantics: the queue is held (not fired) if the in-flight turn errors or is
**Stop**ped, so a follow-up never lands in a cancelled/errored turn. A queued
slash command flushes through the command path. The composer placeholder and the
Enter hint switch to "queue" wording while a turn is streaming.
