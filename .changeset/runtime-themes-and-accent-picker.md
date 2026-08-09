---
"@paddock/web": minor
---

Four runtime themes and a colour picker, in Config → Appearance.

The design system shipped one palette. This adds a theme switcher and three
further themes on top of the neutral base, plus an accent picker — all
per-browser, applied instantly, no save and no restart.

- **Four themes.** `foundation` (the neutral base), `parchment` (a 90s RPG menu
  — wine chrome, brass fittings, corner brackets, an old-style serif),
  `terminal` (green phosphor and ANSI in the dark; greenbar and ribbon ink in
  the light) and `scifi` (deep-space ground and luminous cyan). Both light and
  dark are designed for each, not inverted from one another.
- **Pick any colour for the accent.** The picker takes a colour and nothing
  else: the theme supplies its own saturation and a target contrast, and the
  *lightness is solved* to hit it. An unreadable accent is therefore
  inexpressible rather than merely warned about — it is not possible to choose
  one that fails AA in either mode. Optionally the same colour can tint the
  page ground (None / A little / More). No colour theory is exposed anywhere in
  the UI.
- **Per-instance branding still composes.** With no colour picked, the solver
  reads the hue of whatever `PADDOCK_BRAND_ACCENT` produced, so an operator's
  brand colour is re-solved against the active theme instead of being used at
  whatever lightness it happened to have.
- **Every theme is contrast-guarded.** The build-time guard previously read only
  the base palette, so a theme could ship uncertified. It now walks the theme
  registry and applies the full contract to each one in both modes, and fails
  both ways — a theme registered with no stylesheet, or a stylesheet no one
  registered.

**Fixed: hovering the primary button made its label harder to read.** In dark
mode the fill lightened on hover, taking its white label from 5.53:1 to
**4.17:1** — below AA, on hover, on the most-clicked control in the app. Hover
now raises contrast in both modes. The guard had never paired a foreground with
a hover fill, which is why this was invisible; that pairing is now asserted, and
adding it immediately caught a second instance in `parchment` (6.31:1 → 5.20:1)
where the correct direction is the opposite one, because its fill carries dark
ink rather than white.

The "Appearance" entry in the sidebar is gone — it was a second door onto the
Config section that already holds these settings.
