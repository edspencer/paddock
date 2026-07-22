---
"@paddock/server": patch
"@paddock/web": patch
---

Fix the false "The keeper turn failed" banner rendered beneath a completed reply
(#380). A session-mode turn can stream a normal `end_turn` reply and then have
the SDK's terminal `result` frame arrive with an error subtype (or
`success: false`) — a transient failure the runtime recovered a reply around.
The live path (`ws.ts`) surfaced that dead-end in real time, so a red banner
appeared under a perfectly good answer; a reload cleared it, because the
history-hydration path (`scanTranscriptNotice`) already suppresses a dead-end
once a real assistant reply is the last thing on the transcript.

The live path now applies that same guard: it tracks whether a complete reply
was produced this turn (`messageProducedReply` — a non-synthetic assistant
message with `end_turn` + non-empty text) and suppresses the `error`/`max_turns`
notice when one was, in all three drive loops (human `onChatSend`, spawned
`startAgentTurn`, and the wake loop). `usage_limit` notices are unaffected — a
session-limit stop is a real dead-end worth showing even beside text — and the
`chat:complete` `success` flag is left unchanged; only the user-facing notice is
suppressed. Sibling of #329/#363 (which fixed `is_error:true` on a
`subtype:"success"` result); this is the case where the subtype itself is an
error after a reply already streamed.
