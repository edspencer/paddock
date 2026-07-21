---
"@paddock/web": patch
---

fix(#365): keep the voice-dictation mic usable while the keeper is replying

The composer's mic button was disabled for the whole in-flight turn (`ChatPane`
passed `disabled={streaming}` to `DictationButton`), so voice was locked out
precisely when hands-free queuing is most useful — you could type a follow-up
and have it queue mid-turn, but you couldn't dictate one.

The mic now follows the same enabled semantics as the composer's text input: it
is interactive regardless of turn state. A clip dictated during a live turn
transcribes into the composer draft exactly like typing, and submitting it
follows the existing single-slot queue-while-streaming path (`QueuedMessageStore`,
auto-flush after the turn) — no new send path. Idle behaviour and transcription-
error surfacing are unchanged. The now-unused composer-busy `disabled` prop was
dropped from `DictationButton` (its own record/transcribe/error state still
governs what a click does).
