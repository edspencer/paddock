---
"@paddock/web": minor
---

Design system foundation: Tailwind v4, semantic OKLCH tokens, and an enforced contrast floor.

The UI had no design document and no token layer — colour was addressed by
palette step in 1017 places, with 722 hand-written `dark:` pairs and 200
arbitrary `text-[Npx]` values. One ramp had been tuned against a dark canvas and
reused unchanged against a light one, so light mode failed WCAG AA at its
most-used tokens.

- **Light mode now passes AA.** Help text and field labels went 3.75:1 → 6.71:1,
  muted text and placeholders 2.81:1 → 4.90:1, and the primary button's white
  label 4.17:1 → 5.53:1. Light and dark ramps are now derived separately in
  OKLCH; the mid-steps lose the high-chroma tan cast that made light mode read
  muddy.
- **Contrast is enforced, not asserted.** A new test parses the real stylesheet
  and fails the build if any text-on-surface pair drops below 4.5:1 (3:1 for
  control boundaries) in either mode, or if a colour falls outside the sRGB
  gamut.
- **Shared UI primitives** (`Button`, `Card`, `Section`, `EmptyState`, `Field`,
  `Input`, `Toggle`, `Chip`, `Callout`, `Dialog`, `Menu`). Dialogs now trap and
  restore focus, and menus support arrow-key navigation — neither worked before.
- Chat messages no longer animate in (a 250 ms fade-with-translate on a
  100+/day event), and `prefers-reduced-motion` is honoured throughout.
- Config no longer reflows while you type: a field's width was recomputed from
  its live value on every keystroke, so crossing 38 characters jumped it to full
  width and re-packed every field after it.
- Per-instance branding (`PADDOCK_BRAND_ACCENT`) is unchanged and covered by a
  test.

`docs/DESIGN.md` documents the system, and Tailwind is configured in CSS —
`tailwind.config.js` and `postcss.config.js` are gone.
