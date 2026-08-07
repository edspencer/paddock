---
"@paddock/server": patch
---

Fix silent data loss: the message you send right after deleting a chat no longer
lands in a brand-new session (#730).

The reproduction is an everyday one. Delete the chat you have just finished, go
back to an older one, send a message — and under `driveMode: batch` the message
was silently misfiled into a session that did not exist a moment ago. Nothing
looked wrong: the URL and the transcript on screen kept showing the chat you were
in, and the reply streamed into it. Only on reload did the message turn out to be
gone from that chat, with a stray new chat in the sidebar holding it — and the
keeper's answer had already been written with no memory of the conversation,
because it was a fresh session. It cost exactly one turn: the next send worked.

**What was actually happening.** herdctl keeps one "current session" pointer per
agent at `<stateDir>/sessions/<agent>.json`, rewritten after every batch turn, so
it always names that project's most-recently-active chat. Deleting that chat left
the pointer naming a transcript that was no longer on disk. On the next turn —
any chat, with its session id passed explicitly — herdctl's JobExecutor found the
pointer dangling, cleared it, and then **refused the explicitly-requested resume**
because a pointer had existed a moment earlier, which it reads as "this agent's
session just expired, so start fresh". The pointer named the deleted chat; the
caller asked for a different one; that chat's transcript was right there.

Every rule the bug reproduction turned up falls out of that: only deleting the
**most-recently-active** chat broke anything, `archive` never did (it removes
nothing, so nothing dangles), `promote` did (it deletes the source transcript by
the same call), the damage was scoped to one project (one pointer per keeper),
and it was one-shot (the fresh turn rewrote the pointer).

**The fix** is one `rm` of a file that is already dangling by the time we reach
it: when Paddock deletes or promotes a transcript, it now clears the agent-level
pointer if that pointer names it. herdctl would have cleared the same file at the
next turn regardless — doing it at the moment we make it dangle means the next
turn sees a clean "this agent owns no session" and adopts the caller's explicit
resume, which is the same path a process restart took, and why this always
"worked after a restart". Another chat's pointer is left alone.

The misreading itself is an upstream bug and the real repair belongs there —
filed as edspencer/herdctl#448, which also notes that any consumer whose
transcripts vanish by some other route (a manual `rm`, a retention sweep, a
crashed write) hits the same misclassification. `driveMode: session`, the
default, was never affected: the SDK session path does not consult the pointer
when the caller names a session.

Pinned by `resume-after-delete.test.ts` at the integration tier — a turn after a
delete, and after a promote, must land in the chat it was addressed to, with that
chat's history behind it. There was previously no test anywhere that sent a turn
*after* a delete.
