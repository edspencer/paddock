---
"@paddock/server": minor
"@paddock/web": minor
---

feat(chats): subtree actions, detach-from-parent, and a real tooltip for the chat tree (#508).

The nested chat list (#485) could only act on one chat at a time. Archiving a
parent left its children behind — they lose their parent from the active
population, so `buildChatTree` promotes them to roots and the family silently
scatters back into the main list — and there was no way to say either "take the
whole family with it" or "keep this one out of it".

**Shift-click** on archive, delete, or mark-read/unread now applies to a chat and
**all** its descendants, recursively, matching the count the collapsed-row pill
already shows. A plain click is unchanged. Delete goes through a count-aware
confirmation — "Manager and its 3 nested chats will be permanently removed" —
because a collapsed parent means shift-deleting can destroy chats that aren't
even on screen, and there is no undo.

Those actions run through new **batch endpoints** (`POST
…/chats/batch/{archive,unread,delete}`) rather than a client-side loop. The flag
sidecars commit the whole set in one write, so a parent and its children can't
end up in different states; the delete route can't be atomic (filesystem) so it
attempts every id and reports back which ones it couldn't remove, and the client
only drops what was actually deleted.

**Detach** (`POST …/chats/:sessionId/detach`, an unlink action on any nested row)
promotes a chat to the top level with its own subtree intact, so a family can be
archived *except* one chat. It is persisted as an explicit override that is
checked AHEAD of both parent-resolution tiers — clearing the recorded edge would
not work, because most live edges are *inferred* from the kickoff message and
would simply be re-derived on the next load. Nothing is destroyed, so re-attach
is just clearing the flag.

The delete dialog also names the nested chats it will **keep**: deleting a parent
without its children re-homes them to the top level, and an irreversible action
shouldn't restructure the list silently. That covers a plain delete of a parent
(previously silent) as well as a subtree delete narrowed by an active search.

Single-chat delete now clears a chat's detach override too, alongside the
archived/starred/unread flags it already cleared, so a recycled session id can't
start life detached from a parent it never had.

Discoverability comes from a new shared **`Tooltip`** component, which replaces
every native `title=` in the chat list: themed, portalled out of the sidebar's
scroll container, rich enough to carry "Archive · **Shift-click** to archive all
4", and shown only on the rows that actually have descendants. The same hint is
in each button's accessible name, so the affordance also reaches Shift+Enter from
the keyboard.
