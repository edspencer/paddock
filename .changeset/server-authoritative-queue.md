---
"@paddock/server": minor
"@paddock/web": minor
---

Make the queued-message auto-send server-authoritative (#245). Previously the send was driven by the client (`ChatPane` flushed on a live `chat:complete`), so a queued message stranded if the socket dropped across the turn boundary, and could double-send when both the client and the server backstop fired. Now the server owns draining: it auto-sends a persisted queued message both at turn completion and immediately when a queue is set for an idle session (covering a queue delivered late over the reconnect outbox). An atomic `QueuedMessageStore.take()` plus a client-stamped message timestamp make the drain exactly-once (no double-send, including a stale copy a reloaded client re-asserts). The client no longer self-sends — it persists the queue, and renders the sent bubble + clears its copy when the server broadcasts `chat:queued_flushed` (now reaching a reconnected socket via the hub). Queued slash commands are routed through the command path.
