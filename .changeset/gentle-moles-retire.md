---
"@paddock/web": patch
---

Remove the one-time #488 localStorage read-state backfill (#552)

#488 made read-state server-authoritative and dropped the localStorage
`lastSeen` mirror; to avoid resurfacing already-read chats it shipped a one-time
migration that pushed any surviving `paddock:lastSeen:*` keys up to the server
and deleted them. That migration has drained, but it was wired into the sidebar's
projects effect — so it re-scanned every localStorage key on **every projects
refresh, forever**, only to return early.

`lastSeenBackfill.ts` and the two localStorage helpers it used
(`legacyLastSeenEntries`, `clearLegacyLastSeen`) are gone. The client now has no
localStorage read-state code path at all.

The one caveat: a browser profile that has not opened Paddock since 2026-07-26
still holds legacy keys that will now never be pushed up, so the chats they cover
read as unread once. Those keys are inert — nothing reads them — and opening the
affected chats clears the cue for good.
