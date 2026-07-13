---
"@paddock/web": patch
---

Render CC's post-`/compact` transcript artifacts as clean markers instead of raw user bubbles (#106). The `<command-name>…</command-name>` slash-command echo now shows as a compact `/compact` chip, and the "This session is being continued…" continuation summary renders as a "🗜️ conversation compacted" boundary with the machine-generated summary tucked behind a disclosure — so a compacted chat no longer looks corrupted (it could previously even end on a stray user-styled summary bubble).
