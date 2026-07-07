---
"@paddock/server": minor
"@paddock/web": minor
---

feat: archive chats — non-destructive Archive/Unarchive + collapsible Archived section (#95)

Finished chats can now be filed away instead of only deleted. An Archive button
sits in each chat's hover menu (beside Fork/Rename/Delete) and toggles to
Unarchive on an already-archived chat. Archived chats move into a collapsible
**Archived** section pinned to the bottom of the chat list, collapsed by default
with a count badge; expanding it splits the list ~50/50 with each half scrolling
independently. When the currently open chat is archived, the section auto-expands
on load so you can see where you are. Archiving is a non-destructive toggle — the
transcript is untouched and the chat stays fully openable, resumable, and
forkable.

Server:
- New `ArchiveStore` sidecar (JSON in the data dir, keyed by agent+session) —
  the same pattern as the sweep watermark; ready to move to @herdctl/core's
  `SessionMetadataStore` when that field ships upstream.
- Chat DTOs carry an `archived` flag; `POST /api/projects/:slug/chats/:id/archive`
  and `POST /api/chats/:id/archive` toggle it. Deleting a chat clears its flag.

Web:
- `archived` on the Chat type; `api.archiveProjectChat` / `api.archiveScratchChat`.
- ProjectView partitions the list into current + Archived, with the accordion,
  count badge, 50/50 independent-scroll splitter, and deep-link auto-expand.
