---
"@paddock/web": minor
---

**Visual direction `vellum`** — Paddock as a well-made ledger: a warm board,
pages laid on it, and ink. Keeps the warm identity but re-derives it, and moves
it off the documented "default AI aesthetic" palette (warm cream near `#F4F1EA`
plus a terracotta accent) that the old ramp had drifted into.

- **The ground has substance.** Canvas `#f7f6f1` → `#e1ddd1`. Card-on-canvas was
  1.08:1 — cards were effectively invisible — and is 1.30:1 now.
- **Chroma at the ends, quiet in the middle.** Warmth lives in the board and the
  ink; the rules and hover fills between them drop to a third of that chroma,
  which is what made light mode read muddy.
- **The accent moves off terracotta** (4.17:1 with white, failing AA at the
  most-clicked element in the app) **to iron-gall indigo** at 10.9:1. The rule it
  establishes: the primary action is the darkest thing on a light page and the
  lightest thing on a dark one — dark mode inverts `--accent-solid` to a pale
  plate carrying deep ink. Both sides stay `color-mix`ed from `--accent`, so
  `PADDOCK_BRAND_ACCENT` still propagates.
- **Status hues re-spaced** around the new accent so a blue chip is never
  mistaken for a link.
- **Fira Sans + Literata + Fira Mono**, OFL and self-hosted; Inter and JetBrains
  Mono removed. Sans headings over serif body prose — the inverse of the
  serif-display/sans-body pairing that reads as a landing page.
- **The record is set as long-form.** `OVERVIEW.md` and `CHANGELOG.md` were
  rendering through the compact chat-bubble markdown scope inside a card; they
  are pages now, at a 68ch measure. The transcript column is itself a page and
  the assistant bubble is gone. Turn metadata moves into the page's right
  margin, always visible, instead of a hover-only chip over the text.
- **Home** stops being five identical rounded boxes: a ruled index of live
  state, then a deliberate break into the two document pages.

Every text-on-surface pair clears WCAG AA in both modes (`tokens.test.ts`,
84 assertions), verified again against the running app across 9 routes × 2 modes.
