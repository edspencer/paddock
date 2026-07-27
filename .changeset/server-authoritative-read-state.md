---
"@paddock/web": patch
---

fix(unread): make read-state server-authoritative so devices stop diverging (#488).

The same account could report different unread counts on different devices (observed
live: `herdctl 2 / paddock 36` on one, `herdctl 13 / paddock 61` on another). Read-state
is stored server-side per user, but the client layered a **persistent localStorage
mirror** on top and took `max(server, local)` — so a local value the server never
received marked a chat read on that device only, and the mirror never synced upward.

Remove the persistence, keep the optimism:

- `readLastSeen` now reads only the in-memory cache the server payload folds into —
  no localStorage, no `max()`. Opening a chat still clears its cue instantly via
  `markSeenLocally`, but that bump is session-scoped, so every reload re-derives from
  the server and divergence is structurally impossible rather than merely repaired.
- A failed `/seen` POST now rolls the optimistic bump back (`revertSeenLocally`)
  instead of being swallowed, so the cue reappears honestly rather than sticking.
- Dropped the cross-tab `storage` listener (it only worked via localStorage); another
  tab's mark-seen arrives with the next refetch.
- One-time migration pushes any pre-existing localStorage read-state up to the server
  (resolving each chat's project from the `chatTurns` payload, since legacy keys carry
  only a session id), then purges the legacy keys — so removing the mirror doesn't
  resurface chats the user already read. Safe because the server store is monotonic.

Also fixes a latent bug this exposed: `useUnreadChats` folded the server's `lastSeen`
into a module-level cache from an effect, but the unread derivation had no dependency
on that fold and so never recomputed. It was masked while localStorage was read
synchronously during render; without it, a freshly-loaded chat could show an unread
cue the server already knew was seen.
