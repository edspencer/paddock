---
"@paddock/web": minor
"@paddock/server": minor
---

Give the sidebar's **Home** link the unread / in-flight badge every project row
already has.

The root is a workspace with its own chats, so its sidebar row should say what
every other workspace's row says: an accent pill for unread replies, a spinner +
count for turns in flight, and **nothing at all** when it is quiet. It is the
same `ProjectBadges` component with the same thresholds and the same accessible
labels — not a root-shaped lookalike.

**The data plumbing is the actual change.** The badge is folded from each
workspace's compact `chatTurns` list, which arrives on `GET /api/projects` — and
that route enumerates the root's *children*, so the root's own signal never
reached the client. It does now, as a sibling `root` field on the same response,
built by the same `buildChatTurns` fold as every child. The root stays out of the
`projects` array (it belongs in neither the grid nor the sidebar list), but its
counts land in the same badge map under the empty key, so `useProjectBadges`
computes Home and a project row in one pass with no branch on which is which.

This also removes a round-trip: the projects context used to follow every list
fetch with a full `GET /api/root` workspace-detail request — `changelog` and
`chats` included — and throw everything but the metadata away. One call now
serves both.

`""` is a real, routable workspace key, so the lookup is `badges.get(ROOT_KEY)`
and the server's fold takes the key as an ordinary argument; a falsy guard
anywhere on that path silently drops the root, which is the failure mode the new
tests are pointed at.
