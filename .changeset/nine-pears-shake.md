---
"@paddock/server": patch
---

Make Stop work on slash-command turns (#632)

Pressing Stop during a `/compact` did nothing — permanently. Two wiring gaps:
`onChatCommand` hardcoded `jobId: null` in its routing, so no turn id ever
reached the client (whose cancel is guarded by `if (meta.jobId)`, and whose
deferred pre-arm cancel therefore waited forever); and `runCommand` never
registered its session in `liveSessions`, so even a hand-supplied id resolved to
nothing to interrupt. Since compaction runs 60–180s, that is a long stretch with
no way out.

`runCommand` now mints a synthetic turn id, registers the live session under it
exactly as `chatSession` does (and deregisters it in the same `finally` that
closes the session), and hands it back via `onJobCreated`; `onChatCommand` puts
that id in its routing. `chat:cancel` on a command turn now reaches
`RuntimeSession.interrupt()`.
