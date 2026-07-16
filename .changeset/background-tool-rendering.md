---
"@paddock/web": minor
---

Render background jobs & Monitor as a first-class tool class (issue #230).
Background `Bash` (`run_in_background`), `Monitor`, and the background-task ops
(`BashOutput`/`TaskOutput`/`TaskStop`) now render with a "background" badge, a
clock icon, and a status chip (running / completed / killed / persistent). The
launching call is linked to its result by task id: a background `Bash` shows its
final status + completion summary inline, and a `Monitor`'s streamed events are
grouped under its block instead of scattered as separate notification pills.
Enrichment is server-side (`background.ts`, mirroring the sub-agent path); the
live path falls back to output-sniffing so the badge still shows before reload.
