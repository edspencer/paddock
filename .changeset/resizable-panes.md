---
"@paddock/server": minor
"@paddock/web": minor
---

Draggable, persisted widths for the side-nav and chat-list panes on desktop
(#374). Each pane has a drag handle on its right edge; the chosen width is
clamped to sane bounds, persisted per-browser in localStorage (so a laptop and a
desktop can differ), reset on double-click, and keyboard-resizable (Arrow keys)
for accessibility. Desktop-only — gated on `(min-width: 1024px)` so the mobile
off-canvas drawer layout is unchanged.
