---
"@paddock/server": minor
"@paddock/web": minor
---

Chat list: provenance badges for scheduled / spawned chats (#267)

Surfaces A1's provenance marker (#261) on the per-project chat list so the "ran
without me" cases are legible at a glance.

- The chat DTO now carries `provenance` (`origin` + spawn `depth`), read from the
  `RunProvenanceStore` sidecar in both the project-detail and chat-list payloads
  (and scratch chats), mirroring how the archived flag is threaded.
- The chat-list row renders a small, subtle icon badge for `scheduled` (a schedule
  fired it) and `spawned` (another chat created it) origins, following DD-6's reuse
  of herdctl's trigger-type icons. `human`-origin chats — the default — render no
  badge, so only the unattended runs stand out.
