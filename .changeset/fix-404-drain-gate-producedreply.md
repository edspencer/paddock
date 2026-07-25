---
"@paddock/server": patch
---

fix(chat): flush a queued follow-up after a session-mode turn that ended
`success:false` (#404).

A message queued while the keeper was still replying was silently dropped in
session drive-mode. The queue drain (and the after-turn curation sweep and the
recovery-watch arm) were gated on herdctl's raw `result.success`, which in
session mode routinely reports `false` on a turn that produced a complete reply
but ended with a trailing `error_*` / `success:false` result frame — the same
signal the #380/#394 false-"turn failed" banner fix already learned to distrust.

The live banner path suppressed the benign failure via `producedReply`, but the
post-turn side effects never got the same treatment, so the queued message
stranded. This extracts a single `turnEffectivelySucceeded(rawSuccess,
producedReply)` predicate — the side-effect twin of `suppressNoticeAfterReply` —
and routes the drain, sweep, and recovery gates through it on both the
human-chat path and the shared trigger/spawn/wake turn engine, so a real reply
supersedes a benign trailing failure and the four gates stay consistent. A
genuinely dead turn (no reply) still holds its queue and keeps its error banner.
