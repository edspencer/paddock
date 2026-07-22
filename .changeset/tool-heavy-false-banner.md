---
"@paddock/server": patch
"@paddock/web": patch
---

Fix the false "The keeper turn failed before producing a reply." banner that still
appeared beneath complete, successful replies on tool-heavy turns (residual of
#380/#382; issue #394). The live-path reply predicate
(`messageProducedReply`/`suppressNoticeAfterReply`) required a single assistant
message with text **and** `stop_reason:"end_turn"`, but long tool-driven turns carry
their prose on a message that also makes a tool call (`stop_reason:"tool_use"`) and
end on a thinking-only `end_turn` message (zero text), so `producedReply` never
flipped and the benign terminal `error_*`/`success:false` result surfaced a banner
that only cleared on refresh. The predicate now treats **any** non-synthetic
assistant text as reply-producing (regardless of `stop_reason`), accumulated across
the whole turn on both the interactive and wake emit paths — matching the history
path exactly. A genuinely empty turn (no assistant text anywhere) still surfaces the
error.
