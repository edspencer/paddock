---
title: "Appearance"
description: "Four themes, an accent colour you pick by name or off a strip, and a ground tint — all switchable from the Config screen, per browser, with no save and no restart."
---

Paddock ships **four themes**, an **accent colour** you pick off a strip or by
name, and an optional **ground tint** that colours the whole page. All three are
switchable at runtime, they apply the moment you click, and none of them touches
`paddock.config.yaml`.

## Where it is

The **Appearance** section sits at the top of the **Config** screen — the gear at
the bottom of the sidebar, at `/config` — above the rule that separates it from
the settings that do need a save
(`packages/web/src/components/InstanceConfigForm.tsx`). That separation is
deliberate: everything below the rule needs a restart, and nothing above it does.

It is not a dialog and not a floating dock. Both were tried, and both covered up
the app you are recolouring
(`packages/web/src/components/AppearancePanel.tsx`). The Config screen is dense
with real tokens, so the picker previews itself against a real screen.

Two small consequences of it not being a config field:

- The Config screen's **filter box** matches the section on the words you would
  search for, including the theme names off the registry — typing `parchment`
  finds the section that offers it.
- The **modified only** filter *hides* it. That filter answers a question about
  the config *file*, and this section does not write to the file.

## The four themes

| Theme | What it is |
|---|---|
| **Foundation** | The neutral base. Warm ground, terracotta accent. |
| **Parchment** | Wine chrome, corner brackets, an old-style serif. A 90s RPG menu. |
| **Terminal** | Green phosphor and ANSI in the dark; greenbar and ribbon ink in the light. |
| **Sci-Fi** | Deep-space ground and luminous cyan. Hairlines, telemetry, glow. |

**Foundation is the default** — an instance with nothing saved renders as
Foundation (`packages/web/src/lib/appearance.ts`, `DEFAULT_APPEARANCE`).

The order in the picker is deliberate rather than chronological: the neutral base
first, then the three that are loud on purpose, in increasing distance from it.
That is the axis you actually scan along — *show me something more different than
this* — which is why the four sit in one unlabelled row instead of being grouped.

Each card is a **live scrap of its theme**: its canvas, a card on it, its accent
button and two bars of body text, cascaded by the same `[data-theme]` blocks the
app itself uses. It is not a hand-picked preview hex, so what you see on the card
is what you get on the app.

## Accent colour

Pick a colour by dragging along the spectrum strip, or click one of ten names:
**Ember, Amber, Olive, Forest, Teal, Sky, Indigo, Violet, Magenta, Rose**. A
**Theme's own** button hands the choice back to the theme (or to the instance's
brand colour — see below).

Every position on the strip is painted with the colour that position *actually
produces*, not with a decorative rainbow. Where the maths has to give ground, the
strip shows it rather than promising a vividness the app will not deliver.

### What happens to the colour you pick

You contribute the *position on the spectrum*, not a finished colour. The theme
supplies how saturated its accent is, and Paddock then **solves for the lightness**
that clears a WCAG AA floor against that theme's own surfaces — 4.5:1 wherever the
colour carries or sits under text, 3:1 for a non-text mark
(`packages/web/src/lib/accent.ts`). You are not picking a colour that then gets
validated; you are picking a hue that gets *reshaped* until it clears the bar.

Three things fall out of that which are worth knowing:

- **The floor is the guarantee; matching the theme is only a preference.** Paddock
  aims higher than the floor — at whatever contrast the theme's own accent already
  achieved — but will not chase that at any cost. Terminal's acid-green plate
  manages 13.6:1 against black ink, and demanding 13.6:1 of every other colour
  would hand back a pastel wherever you asked for Rose. So when matching the theme
  would cost more than about a quarter of its saturation, Paddock gives up contrast
  back down toward the floor rather than giving up the colour you picked. That is
  why the ten names look like themselves in all four themes.
- **It checks what the theme *derived*, not just what it was handed.** Themes build
  their accent family differently — one mixes toward white, another inverts the
  polarity entirely — so after solving, Paddock re-reads the primary button, its
  hover state and accent text *as actually rendered* and repairs any that came out
  under its floor. That is what makes the floor hold for a theme nobody has written
  yet.
- **Some themes carry dark type *on* the accent** — Parchment's primary button is
  a struck brass coin — so "readable" is not always "darker". Paddock measures
  which way round each theme works instead of assuming.

:::note[The edge it does not cover]
Reshaping is how the floor is delivered, so you cannot express a failing accent by
picking one. What Paddock does *not* do is tell you when the solve itself could not
get there: at a few combinations of hue and saturation the floor is not physically
reachable, and the closest result is applied with no warning
([#813](https://github.com/edspencer/paddock/issues/813)). If an accent looks hard
to read to you, trust that over the maths and move to a neighbouring colour or back
to **Theme's own**.
:::

The panel deliberately exposes none of this vocabulary. There is no hue field, no
hex box, no chroma slider. The restraint is the feature: the maths exists so the
control can be this small.

## Tint the background

**None**, **A little**, or **More**. This colours the page surfaces — and, at
half strength, the body text — toward your accent, rather than only the buttons.
The amounts are small on purpose: at the strongest setting a surface is
unmistakably *the blue one* across a room and still reads as a neutral up close.

The most useful thing it does is tell two Paddock instances apart at a glance.

Lightness is left strictly alone, which is what keeps the tint safe: at these
amounts, colouring a surface without moving its lightness barely shifts its
contrast with the text on it. Paddock measures the worst text-on-surface pair
afterwards and folds it into the same readability check as the accent — but note
the asymmetry, because it is the opposite of what the accent does: a tint that
lowers contrast is **not** repaired, and nothing tells you
([#816](https://github.com/edspencer/paddock/issues/816)). If **More** makes body
text harder to read on your screen, drop back to **A little** or **None**.

## Scope: per browser, not per instance

This is the part most likely to surprise you.

- The choice is **per device**, kept in your browser's `localStorage` under
  `paddock:appearance` (with `paddock:appearance-cache` holding the solved accent
  so the theme paints before React boots, instead of flashing the default).
- It applies **immediately**: no save button, no restart.
- It is **not** in `paddock.config.yaml`, and **there is no `PADDOCK_THEME`**.

So two people using the same Paddock instance can see two different themes, and
the same person can see different themes on their laptop and their phone. That is
by design, and it mirrors how the light/dark toggle has always worked.

:::note[The instance-default half is a deliberate stub]
The design is a two-scope model — a per-device override on top of an instance
default — and only the per-device half is built. A `theme:` key in the config file
and a matching `PADDOCK_THEME` are server plumbing that has not shipped
(`packages/web/src/lib/appearance.ts`). This is a stated limitation, not a bug.
:::

## Light and dark

Light/dark is still its own toggle, stored separately in `paddock:theme`
(`packages/web/src/lib/theme.ts`), and it is independent of which of the four
themes you are wearing — every theme has both. **Dark is the default.**

Flipping it re-solves the accent, because the surfaces the accent was measured
against are exactly the ones that just swapped.

## How `PADDOCK_BRAND_ACCENT` fits in

If you run several instances and brand them apart with
[`PADDOCK_BRAND_ACCENT`](/configuration/environment/#branding-per-instance), that hex is now
read for its **position on the spectrum and nothing else**. Its lightness and
saturation are discarded and re-solved against whichever theme the viewer is
using (`packages/web/src/lib/appearance.ts`, `instanceDefaultHue`). It is used
whenever a viewer has not picked their own colour; anyone who does pick one
overrides it, for their browser only.

For an operator the consequence is the useful part: **a brand hex is no longer
painted onto buttons as-is**, so it can no longer drag a theme's primary button to
whatever lightness the hex happened to have. Ten plausible brand hexes were
measured against one theme during the design work and only two were readable;
under this seam they go through the same solve and the same repair pass as a
hand-picked colour, because lightness stopped being an input.

The server still injects its `:root{--accent…}` style block, but the theme blocks
and the solved inline values outrank it — it is there, it just no longer decides
anything.

## For contributors

The user-facing surface is the whole of what this page covers. If you are
changing how Paddock *looks* — adding a theme, touching a token, writing a
component — read
**[`docs/DESIGN.md`](https://github.com/edspencer/paddock/blob/main/docs/DESIGN.md)**
in the repository first. It is the token contract, the type/space/radius scales,
the shared `ui/` primitives, a step-by-step "How to add a direction", and a
"Reject this" section aimed squarely at AI coding agents. The rules in it are
enforced by `packages/web/src/styles/tokens.test.ts`, which fails the build.
