---
"@paddock/server": minor
"@paddock/web": minor
---

Stream keeper replies token-by-token in the web UI (#315).

Session-mode turns now opt into partial (streaming) assistant messages from
herdctl (`@herdctl/core`/`@herdctl/chat` ≥ the herdctl#382 release): both
`HerdctlService.chatSession` and `runCommand` pass `includePartialMessages: true`
to `openChatSession`. The SDK then emits `stream_event` / `text_delta` chunks that
`@herdctl/chat`'s translator surfaces as incremental `onText` calls, which the WS
layer already forwards as `chat:response` `{ chunk }` frames — so a keeper reply
now accretes into the live bubble token-by-token instead of landing in one drop.

The transport was already delta-shaped (per-turn hub buffer, replay, and
`ChatPane` chunk-append are delta-agnostic), so re-attach/replay is unchanged and
no coalescing was needed. Only session-mode (SDK-runtime) instances benefit;
batch-mode keeps whole-message rendering.
