---
"@paddock/web": patch
---

Home's empty states are invitations rather than voids.

A quiet workspace rendered five near-identical rounded boxes down one viewport,
four of them dead ends — "Nothing running right now.", "No unread replies. All
caught up.", "No files yet.", "No OVERVIEW.md yet." — with nothing to do about
any of them, and the first two saying the same thing twice in a row.

The two attention feeds now collapse into a **single** panel when both are empty,
because both empty is one state, not two; that panel is the only place on the
screen carrying a primary action ("New chat"). It is deliberately not shown while
the feed is still loading, or when the feed errored — claiming all is caught up
before the answer has arrived is a lie the reader acts on.

The remaining empty states stay quiet and say who fills them in and when, which
is the thing the reader actually lacked: `OVERVIEW.md` and `CHANGELOG.md` are
written by the post-turn sweeper rather than by hand, so "No OVERVIEW.md yet." on
its own left no clue whether that was theirs to fix.

One moment of weight, three quiet lines — instead of four identical boxes.
