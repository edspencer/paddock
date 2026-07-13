---
"@paddock/server": patch
---

Preload now injects `CHANGELOG.md` alongside `OVERVIEW.md` (#188). Previously the "Preload project context" checkbox only prepended `OVERVIEW.md` to a new project chat's first turn, so the cross-session narrative in `CHANGELOG.md` — written by the sweeper but never fed to a chat — was effectively write-only. The checkbox now opts into **both**: when a curated overview exists, the first turn's `<project-context>` block carries the overview (current state) *and* the changelog (history). Gating is unchanged (still requires an `OVERVIEW.md`, i.e. a sweep has run), and the display-strip round-trip is preserved.
