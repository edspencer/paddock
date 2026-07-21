---
"@paddock/web": patch
---

Persist unsent composer attachments across navigation and reload (#346).

The composer already restores unsent **draft text** after a chat switch or page
reload, but staged **attachments** were dropped — attach a file without sending,
navigate away or refresh, and the tray came back empty. Attachments are uploaded
to the server on attach and the composer holds only lightweight refs (the bytes
live durably in the attachment store), so the fix mirrors the existing draft/queued
persistence: a new `lib/attachmentRefs.ts` helper stashes the ref array in
`localStorage` (keyed per-chat by `sessionId` or `new:<slug>`), `ChatPane` seeds
the tray from it on mount and persists on every tray change, and sending clears it.
Restored refs whose server file was cleaned up degrade gracefully — a broken image
falls back to a file chip instead of breaking the composer.
