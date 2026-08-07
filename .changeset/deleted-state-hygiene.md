---
"@paddock/server": patch
"@paddock/web": patch
---

Deleting something now takes its bookkeeping with it (#732, #734). Both bugs are
the same defect one layer apart: herdctl's `job-*.yaml` records feed the sidebar
unread badge and the run history, the directory was append-only, and **nothing
had ever removed a record** — so a record outlived whatever it described.

**The sidebar unread badge no longer sticks at a count you cannot clear
(#732).** `chatTurns` — the badge's feed — was built purely from job records, and
deleting a chat left its record behind. Delete two of three unread chats and the
badge still read `3` while the project had one chat and the Home Unread feed
correctly reported `1`; mark the survivor seen and the badge dropped to `2` with
**no chat left to open** to clear the rest. Reload didn't help — it is what the
server said.

Fixed at both ends. A chat's job records are dropped when the chat is deleted
(one choke point, so the per-chat and batch routes both get it), and
`GET /api/projects` prunes `chatTurns` against the chats that actually exist — so
an instance already stuck self-heals, and a transcript that leaves by some other
route (an adoption undone, a JSONL removed by hand) cannot re-stick it. A failed
chat listing is treated as *unknown*, never as *empty*, so a transient error
leaves the badge alone rather than silently zeroing it.

The client half is fixed too, and it is the half that matters on the default
`session` drive mode: that runtime writes no job records at all, so the badge is
fed mostly by live turn-completions over the WebSocket, held in a cache that also
only ever grew. Deleting a chat now retracts it from that cache immediately, and
completions belonging to a project that has gone away are dropped on the next
projects fetch.

**An archived chat is now silent on both surfaces.** It used to count toward the
sidebar badge while being excluded from `/chats/attention`, so the badge could
read `3` with the Home Unread feed showing nothing — the two surfaces disagreeing
about the same state, which is exactly what making read state server-authoritative
(#488) was meant to rule out. Archiving is the user filing a chat away, so it now
silences both. It silences rather than consumes: unarchiving brings the chat back
to both surfaces.

**Deleting a project and creating a new one with the same name no longer
resurrects the old one's history (#734).** Job records are keyed by agent name,
which derives from the slug, which derives from the *name* — so a re-created
"Foo" inherited the previous incarnation's `/runs`, prompt text and reply
summaries included, plus a phantom unread badge over a project with zero chats.
Files, `.chats/` and `read-state.json` were already cleaned; these were the one
thing left. A project delete now purges the records of every agent it owned
(keeper, sweeper, hooks, triggers), so the inverse of create is complete.

This is the containment fix, not the structural one: the durable answer is to key
records by a stable project id rather than by a user-controlled, reusable slug,
which is a change to herdctl's record format. Purging on delete closes the leak
now and stays correct afterwards.
