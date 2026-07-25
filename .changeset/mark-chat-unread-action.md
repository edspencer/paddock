---
"@paddock/server": minor
"@paddock/web": minor
---

feat(chats): add a sixth chat action to mark a conversation unread (#458).

A new hover action on each chat row toggles the chat's read/unread state — the
email-client pattern for "I glanced at this late at night, resurface it in the
morning". Marking a read chat unread re-raises its accent-dot cue; marking an
unread chat read is equivalent to the existing mark-seen flow.

- **Server:** a new per-user `UnreadStore` sidecar (`unread-state.json`) holding a
  manual "unread" override, layered on top of the derived read-state. It's keyed
  by user like read-state (not shared like star/archive), since "I haven't dealt
  with this yet" is personal. New `POST .../chats/:id/unread` routes (project +
  scratch); the existing `/seen` routes now also clear the override, so opening or
  focusing a chat spends the flag. The flag surfaces on the chat DTO as `unread`.
- **Web:** a `toggleUnread` handler (optimistic with rollback, mirroring
  archive/star), a sixth envelope button in the session sidebar, and the unread
  derivation now folds in the manual override. The `useUnreadChats` hook clears
  the override whenever a chat is marked seen so the cue can't flicker back.
