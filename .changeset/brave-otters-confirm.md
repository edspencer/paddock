---
"@paddock/server": minor
"@paddock/web": minor
---

Confirm native-chat imports before they happen, and let them be undone

"Import N native chats" was a permanently-visible sidebar button that imported
everything on one click, showed nothing about what it was about to take, and
could not be undone from the UI. The absence of a dismiss was deliberate and
well-argued — a live count beats a stale dismissal flag — but that reasoning
assumes the count is trustworthy, and it has not been: the same button has
offered Paddock's own sweeper output and another instance's chats.

The click now opens a dialog listing the candidate sessions grouped by the
directory they came from, with their date, size and first message. Everything
starts ticked, because "yes, all of it" really is the common case. The source
path is the load-bearing detail — it is what makes "these are from a scratch copy,
not my checkout" visible before anything is imported rather than after.

A successful import offers **Undo** on its toast, which releases the adoptions and
deletes the copies the import placed. The user's own `~/.claude` history is never
touched. Which files an undo may delete is decided server-side from what the
import actually did, so the request carries session ids and no paths; the offer
lives in memory and expires with a restart, in which case undo reports that there
was nothing to undo rather than acting on a stale record.

API changes:

- `GET …/adoptable-chats` sources gain a `sessions` array (`mtime`, `preview`,
  `autoName`, `sizeBytes`) alongside the existing `sessionIds`.
- `POST …/adopt-chats` accepts `sessionIds` to import a chosen subset.
- `POST …/unadopt-chats` is new.

The live count is unchanged, and there is still no dismiss state.
