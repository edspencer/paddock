# Paddock — visual design system

This is the repo's **only** design document about how Paddock *looks*. Every
other `DESIGN-*.md` here is architecture. Until this file existed, the visual
language lived entirely in `packages/web/tailwind.config.js` and a 494-line
`index.css`, which is how the app arrived at 1017 raw palette-step uses, 722
hand-written `dark:` variants, 200 arbitrary `text-[Npx]` values, zero shared
React primitives, and a light mode that failed WCAG AA at its four most-used
tokens.

It describes a **system**, not a look. The baseline theme shipped here is
deliberately neutral: it proves the system works and fixes the measured defects.
It is not the final aesthetic.

**If you are an AI coding agent working on Paddock's UI, read "Reject this"
(§7) before you write a line of CSS.** It is aimed at you specifically.

---

## 1. The architecture in one paragraph

Colour lives in exactly one file — `packages/web/src/styles/tokens.css` — as
**semantic** custom properties, declared twice: once under `:root` (light) and
once under `.dark`. `packages/web/src/index.css` maps those onto Tailwind
utilities through `@theme inline`, so `bg-surface-raised` resolves to
`var(--surface-raised)` and re-themes itself when the class on `<html>` flips.
Components name meanings (`text-fg-muted`, `bg-danger-soft`), never colours.
Shared React primitives in `packages/web/src/components/ui/` own the structural
decisions. **A visual direction is therefore a set of token values plus a
typography choice** — not a rewrite of components.

```
styles/tokens.css   ← the values. A direction edits this.
index.css           ← @theme mapping + scales + the few class-level primitives.
components/ui/      ← structure. A direction edits this only where it genuinely differs.
components/, routes/← consume utilities. A direction should not need to open these.
```

## 2. Token architecture and naming rules

### The rules

1. **A token is named for what it means, not what it is.** `--danger-soft`, not
   `--rose-50`. If you cannot say what a token *means* in the product, it is a
   palette step and does not belong here.
2. **Semantic tokens only at the point of use.** A component may write
   `text-fg-muted`. It may not write `text-paddock-500`, `text-[#8f7c54]`, or
   `dark:text-paddock-400`.
3. **The mode swap happens once**, at `:root` / `.dark` in `tokens.css`. A
   `dark:` variant in a component is a bug unless the rule genuinely differs per
   mode *beyond colour* (there are almost no such cases).
4. **Author in OKLCH.** Lightness steps are then perceptually even and chroma is
   independent of lightness, which is what lets the two modes be tuned
   separately.
5. **Derive the light and dark ramps separately.** The pre-token palette tuned
   one ramp against a dark canvas and reused it unchanged against a light one.
   That single decision produced every contrast failure listed in §4.
6. **Tint borders, shadows and muted text toward the background hue.** Neutral
   grey on a hued surface reads as dirt.

### The token set

| group | tokens | means |
|---|---|---|
| surface | `--surface` `--surface-raised` `--surface-sunken` | the page canvas · anything floating above it (card, menu, dialog, composer) · anything reading as a well (input, code block, track) |
| surface, interactive | `--surface-hover` `--surface-active` `--surface-selected` | fills laid over any of the three above |
| scrim | `--overlay` | modal / drawer / lightbox backdrop |
| text | `--text` `--text-muted` `--text-subtle` | primary body & headings · secondary (labels, help, metadata) · tertiary (placeholder, timestamp, disabled, empty-state copy) |
| text on fill | `--text-on-solid` | anything sitting on a saturated colour |
| border | `--border-subtle` `--border` `--border-strong` | divider inside a container · container edge · control boundary, hover edge, focus-adjacent |
| accent | `--accent` `--accent-600` `--accent-700` | **the brandable seam — see §3** |
| accent, derived | `--accent-color` `--accent-solid` `--accent-solid-hover` `--accent-fg` `--accent-text` `--accent-soft` `--accent-border` | |
| status × 5 | `--<hue>-solid` `--<hue>-fg` `--<hue>-text` `--<hue>-soft` `--<hue>-border` | see below |
| effects | `--shadow-color` `--shadow-ambient` `--shadow-direct` `--scroll-thumb` | |

### The five domain hues

Paddock's UI encodes exactly five colour meanings. They were previously spelled
in seven Tailwind families (`emerald`, `rose`, `red`, `amber`, `sky`, `violet`,
`zinc`) across four mutually-incompatible chip recipes.

| token | was | means |
|---|---|---|
| `success` | emerald | added · completed · enabled · connected · adopted · a string literal |
| `warn` | amber | caution · pending · modified · paused · dirty worktree · starred · context pressure · a schedule-provenance chat |
| `danger` | rose **and** red | error · failed · deleted · destructive action · stderr |
| `info` | sky | informational · in progress · background task · repo-backed · a hook-provenance chat |
| `lineage` | violet | **derivation and structure**: a renamed file, a diff hunk header, a spawned chat, trigger type = schedule |

`lineage` is the one that needs explaining. It is not a severity — it marks
"this thing came from that thing". Keep it distinct from `info`.

Each hue carries the same five slots, so they are interchangeable at a call
site: `-solid` (saturated fill: dots, destructive button), `-fg` (foreground on
that fill), `-text` (the hue *as text*, on a neutral surface or on its own
`-soft`), `-soft` (tinted background: chips, banners, diff lines), `-border`
(edge of a `-soft` banner).

`zinc` had one use — `StatusPill`'s `abandoned` — and is not a sixth hue. Inert
things use the neutral tokens.

## 3. The brandable accent seam (issue #34)

`--accent`, `--accent-600` and `--accent-700` are **space-separated sRGB
channels**, not OKLCH:

```css
--accent: 194 96 60; /* #c2603c */
```

A running server rewrites exactly those three by injecting
`<style>:root{--accent:…;--accent-600:…;--accent-700:…}</style>` before `</head>`
for `PADDOCK_BRAND_ACCENT` (`packages/server/src/brand.ts`, which derives the
600/700 shades by darkening so an operator picks one colour).

Therefore:

- Do not rename those three, and do not convert them to `oklch()`.
- Every other accent-flavoured token must **derive** from them (`rgb(var(--accent-600))`,
  `color-mix(in oklab, rgb(var(--accent)) 74%, white)`), or branding silently
  stops applying to whatever you hard-coded. `tokens.test.ts` asserts this by
  substituting a fake brand colour and checking every derived token moves.
- **Known limitation:** contrast is verified for the *default* accent. An
  operator who sets a pale `PADDOCK_BRAND_ACCENT` can drive white-on-accent
  below 4.5:1, and nothing at build time can catch it. A future fix is
  `contrast-color()` once it ships, or computing the foreground server-side in
  `brand.ts`.

## 4. Contrast is enforced, not asserted

`packages/web/src/styles/tokens.test.ts` **parses the real `tokens.css`** —
resolving `oklch()`, `rgb(var(--x))`, `color-mix(in oklab, …)` and `var()` chains
through `src/lib/color.ts` — and fails the build if any pairing drops below AA.
It checks, in **both** modes:

- every one of `--text` / `--text-muted` / `--text-subtle` / `--accent-text` on
  every one of the six surfaces, at **4.5:1**;
- each hue's `-text` on `surface`, `surface-raised`, `surface-sunken` and its own
  `-soft`, at 4.5:1;
- each hue's `-fg` on its `-solid`, and `--accent-fg` on `--accent-solid`;
- `--border-strong` at **3:1** on every surface (WCAG 1.4.11, non-text);
- every `oklch()` token inside the sRGB gamut (an out-of-gamut value clips
  silently in the browser and quietly loses the contrast you thought you had);
- the brand seam described in §3.

This is the thing that makes several competing visual directions *trustworthy
rather than four opinions*. If you change a token and this fails, it tells you
the exact pair, both hex values, and the ratio.

What it fixed, measured on `main`:

| token | uses | on `main` | now (light / dark) |
|---|---|---|---|
| help text, `.field-label` (`paddock-500`) | 96 | **3.75:1** light | 6.71 / 6.62 |
| muted + placeholder (`paddock-400`) | 163 | **2.81:1** light | 4.90 / 4.87 |
| primary button, white on accent | 40 | **4.17:1** both | 5.53 / 5.53 |

The primary-button fix is why the button fill is `--accent-600` rather than the
raw brand accent: the accent stays the brand colour everywhere it does not carry
text.

### The limit of this guarantee: it reads tokens, and the screen shows pixels

`tokens.test.ts` (and `themes.test.ts`, which applies the same contract to every
runtime theme) resolves **declared token values**. If anything composites on top
of a surface — a blend mode, a texture tile, a translucent overlay — the colour
that reaches the eye is not the colour the guard measured, and the guard has no
way to know. It does not report a smaller margin. **It reports a number that is
not on screen.**

This is not hypothetical. The `parchment` theme laid a texture tile over its
chrome with `background-blend-mode: soft-light`. `soft-light` is asymmetric on a
dark backdrop — below a base of about 0.25 it lifts far more than an equally
distant darker sample lowers, and it lifts the low channels of a saturated colour
proportionally most. The result:

| | value |
|---|---|
| intended chrome (token) | L **0.332** |
| actually painted | `#7c3d49`, L **0.444** |

A 0.11 lift, plus desaturation, across the nav rail and the header slab — the
largest saturated area on screen. Every chrome assertion passed. A human said "it
looks pink" twice and was told the token value twice; the first measurement of an
actual pixel settled it in about ninety seconds.

**So, for any theme that composites over a surface, satisfy _one_ of these two.**
They are alternatives, not a sequence — the second is strictly better because it
lets a theme have real texture instead of a whisper of one:

**(a) Keep the composite negligible.** Painted pixel within **ΔL 0.01** of the
token, verified by sampling the rendered page. Then the existing token-based
guards remain true and nothing else is needed.

**(b) Model the composite in the guard, and assert against the worst painted
pixel.** `theme-parchment.test.ts` is the worked example: every surface there is
`background-color` + a `multiply`-blended noise tile, so the real background is
the token times some factor in `[TEXTURE_MIN, 1]`. The guard multiplies the
background down by `TEXTURE_MIN` before measuring contrast — light mode only,
because `multiply` can only darken and a darker background under *light* text
only raises the ratio, so the flat token is already the worst case in dark mode
and on the chrome.

Route (b) carries one obligation that is easy to forget: **`TEXTURE_MIN` is a
hand-maintained mirror of the tile's own range, and nothing enforces the
coupling.** Change the tile's `feFuncR` slope/intercept or its opacity and the
constant silently stops describing the CSS — the same failure as before, one
level up. So re-measure it when the tile changes. Measured on the shipping
theme: the darkest real ground pixel is **0.959** of the token against a
`TEXTURE_MIN` of **0.93**, i.e. conservative with room to spare — and the painted
ground is ΔL **0.019** from its token, which is why route (a) alone would not
pass and route (b) is what makes the theme legal.

Whichever route: **prefer `multiply` to `soft-light` or `overlay`.** `multiply`
can only darken, so the error is bounded and points in a known direction.

**How to sample.** Screenshot, decode, take the **median** of a patch, convert to
OKLab L. Use the median rather than the mean, and check the patch is bare surface
first: a patch that clips a glyph shows a min/max spread of ~116/255 where clean
ground is ~6, and its minimum is antialiasing rather than texture. `ffmpeg` is on
the box and decodes PNG directly:

```sh
ffmpeg -v error -i shot.png -vf "crop=8:8:X:Y" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 -N3
```

**And when a human's report and your instrument disagree, check the instrument.**

Today only `parchment` uses a blend mode. `scifi` and `terminal` use alpha and
gradients, which the rendered-node audit already handles. Note that route (b)
currently lives in parchment's own test file — the shared `themes.test.ts` still
reads flat tokens, so a ninth theme that composites inherits **no** protection
until it writes its own. That is the next piece of work on the guard.

## 5. The scales

### Type

Tailwind's `xs`(12) `sm`(14) `base`(16) `lg`(18) `xl`(20) `2xl`(24) `3xl`(30)
rungs are kept **unchanged** — the app's body size is `text-sm`, and redefining
it would resize the entire product. Three rungs are added, for the sizes the app
was faking with 200 arbitrary values across 9 distinct pixel sizes:

| rung | px | for |
|---|---|---|
| `text-3xs` | 10 | dense metadata, counts, letter badges |
| `text-2xs` | 11 | chips, pills, section labels — the single most-used size |
| `text-md` | 15 | document prose (the file viewer), one notch above UI text |

11.5px collapsed to 11, 12.5px to 12, 13px to 14, 17px to 18, 28px to 30. None
of those differences was doing any work.

Also: `font-variant-numeric: tabular-nums` (the `tabular` utility) anywhere
numbers are compared column-to-column — token counts, durations, timestamps, the
Config screen. `text-wrap: balance` is applied to `h1`–`h4` in base. Use `…` not
`...`, curly quotes, and non-breaking spaces in `10 MB` / `⌘ K`.

### Space

Tailwind v4's dynamic spacing, `--spacing: 0.25rem`. Everything is a multiple of
4px; there is no bespoke scale and none is wanted. Gutters run 2/3/4/6, section
rhythm 6/8/9.

### Radius — concentric

A child's radius is **one rung below its parent's**, so nested corners stay
parallel rather than pooling:

```
dialog / card   rounded-2xl (16)
  panel         rounded-xl  (12)
    control     rounded-lg  (8)
      chip      rounded-md  (6)
        badge   rounded-sm  (4)
```

`--radius-*` are real custom properties, so a squarer direction sets them all to
`0` in `tokens.css` and the whole app follows.

### Elevation — layered

Never one flat `shadow-sm`. Every rung is **ambient + direct**: a tight,
higher-opacity shadow for the contact edge plus a wide, softer one for the
occlusion. `--shadow-color` is warm-tinted in light mode and neutral black in
dark; `--shadow-ambient` / `--shadow-direct` set the two opacities.

Crisp edges come from a **semi-transparent border plus a shadow**, not an opaque
border.

### Motion — frequency decides whether to animate at all

| frequency | example | rule |
|---|---|---|
| 100+/day | keyboard actions, command palette, **a chat message arriving** | **no animation** |
| occasional | modals, drawers, toasts | standard |

Durations: `motion-fast` 120 ms (feedback) · `motion-base` 180 ms (state change)
· `motion-slow` 300 ms (layout). **Exit faster than entrance** — long feedback
reads as latency.

Animate `transform` and `opacity` only. Never `top`/`left`/`width`/`height`.
Never `transition: all`. `prefers-reduced-motion` collapses every transition to
0.01 ms and stops every keyframe animation, in base.

The previous `fade-in` was 250 ms *with a 4px translate* and fired on every
arriving chat message — precisely the case that should not animate. It is now
opacity-only, 120 ms, and reserved for occasional chrome.

## 6. The primitives

`packages/web/src/components/ui/`. Import from the folder:
`import { Button, Card, Field } from "../components/ui"`.

| primitive | file | use when |
|---|---|---|
| `Button` | `Button.tsx` | any button. `variant`: primary · ghost · subtle · danger · link. `size`: sm · md · icon-sm · icon-md. `loading` + `loadingLabel` replaces the `{saving ? "Saving…" : "Save"}` idiom that appeared 13 times. |
| `Card` | `Surfaces.tsx` | a raised container. `interactive` opts into the hover treatment — the old `.card` baked a hover lift into all eight uses, six of which were not clickable. |
| `Section` | `Surfaces.tsx` | a titled group. `variant`: `card` (settings-style) · `rule` (long-form config) · `bare`. Replaces two incompatible local `Section`s plus five inlined variants. |
| `EmptyState` | `Surfaces.tsx` | **any** empty slot. `variant`: `inline` (quiet, inside an already-titled section) · `panel` (the full invitation, with an icon and a CTA). |
| `Input` `Textarea` `Select` | `Form.tsx` | one shared control style so the three cannot drift apart. |
| `Field` | `Form.tsx` | label + control + help/error, correctly associated via `htmlFor` and `aria-describedby`. |
| `Label` `Hint` | `Form.tsx` | when `Field` is too much structure. |
| `Toggle` `Checkbox` | `Form.tsx` | a switch-styled checkbox (still a real checkbox) and a plain one, at **one** size. |
| `Chip` `StatusDot` `Callout` | `Chip.tsx` | small inline labels. `tone` takes a *meaning* (`success`/`warn`/`danger`/`info`/`lineage`/`accent`/`neutral`). `Callout` is the tinted notice that had been copy-pasted into 13 files. |
| `Dialog` | `Overlay.tsx` | every modal. Handles Escape, backdrop dismissal, **focus trap and focus restoration** — none of the eight ad-hoc overlays did either. |
| `Menu` `MenuItem` | `Overlay.tsx` | a dropdown. Handles outside-click, Escape and arrow-key roving, which the two ad-hoc menus claimed via `role="menu"` but never implemented. |

Primitives are **styled by token only**. That is the contract that lets a
direction restyle the whole app without opening a route file.

### Structure & content rules

- **Repeated patterns, then a deliberate break.** Four identical sections is
  monotony.
- **An empty state is an invitation to act**: headline, one line of explanation,
  a primary action. Positive framing. No dead ends — always offer a next step or
  a recovery.
- **Design the dense state, not just the empty one.** This is a tool for someone
  with 7 projects and thousands of chats.
- Hit targets ≥ 24 px (≥ 44 px touch). Flex children that can truncate need
  `min-w-0`.
- Focus rings via **`box-shadow`, not `outline`** — `outline` ignores
  `border-radius` and paints a rectangle around a rounded control. Use the
  `focus-ring` utility or `focus:ring-*`.
- Increase contrast on `:hover` / `:active` / `:focus`, never decrease it.
- Hover-only affordances must be behind the **`can-hover:`** variant. Touch
  browsers (iOS Safari especially) apply a *sticky* `:hover` after a tap that
  persists until the next tap elsewhere, so an ungated hover reveal gets stuck
  on. This is not theoretical; it is why the variant exists.

## 7. Reject this

*Written for a future coding agent. These are the specific failure modes, and
the first three are documented defaults you will produce unless you decide not
to.*

**The three default-AI-aesthetic clusters. Avoid all three.**

1. A **warm cream background** near `#F4F1EA` with a high-contrast serif display
   face and a **terracotta** accent. Paddock's pre-token palette was, by
   coincidence, exactly this: canvas `#f7f6f1` is 7/255 from that hex and the
   accent is terracotta. The baseline theme in this repo still sits near it, on
   purpose, because the token migration had to be a refactor. **A new direction
   must move away from it.**
2. A **near-black background** with a single bright acid-green or vermilion
   accent.
3. A **broadsheet layout**: hairline rules, zero border-radius, dense newspaper
   columns.

**Local rules, all machine-enforced by `styles/tokens.test.ts`:**

- **Never a literal hex, `rgb()` or palette step in component code.** Not
  `#c2603c`, not `text-paddock-500`, not `bg-emerald-100`. The single exception
  is `src/lib/brand.ts`, which mirrors the server's default accent and is the
  branding seam. This rule is the only thing that stops 1017 raw uses
  re-accumulating.
- **Never an arbitrary `text-[Npx]`.** Use a rung of the scale. If no rung fits,
  the answer is almost always that the design is wrong, not that the scale is.
- **Never a bare `outline` focus ring.** `box-shadow`.
- **Never `transition: all` / `transition-all`.** Name the properties.
- **Never a `dark:` variant for a colour.** The token swaps itself. If you are
  writing one, you have hard-coded a colour somewhere.

**And the judgement call the tests cannot make:**

> Plan a compact token system, then **critique the plan before building** — if
> any part of it reads like the generic default you would produce for any
> similar page, revise that part. Spend boldness on **one signature element**
> and keep everything around it quiet and disciplined. Then, before you ship,
> take one thing off.

Anthropic's guidance explicitly advises **against Inter**. The baseline keeps it
because the baseline is a refactor; a direction has no such excuse.

## 8. How to add a direction

*Written for someone with no context, because that is literally what happens
next.*

You will touch **two files**. Possibly three.

### Step 1 — `packages/web/src/styles/tokens.css`

Replace the values in the `:root` block (light) and the `.dark` block (dark).
Do not rename keys. Do not add keys — if you need a colour that has no token,
you have found either a missing meaning (add it to both blocks and to §2 above)
or a component that should have been using an existing one.

Author in OKLCH. Derive the two modes **separately**: pick your surfaces first,
then find the text lightness that clears 4.5:1 against the *darkest* surface
that text can legally sit on (in light mode that is `--surface-sunken`, because
`--text-subtle` is the placeholder colour and a placeholder is real text).

Keep `--accent` / `--accent-600` / `--accent-700` as space-separated sRGB
channels and keep every other accent token derived from them (§3).

The non-colour scales are also overridable from this file, because they are
emitted as real custom properties. A squarer direction adds to `:root`:

```css
--radius-lg: 0; --radius-xl: 0; --radius-2xl: 0;
```

Same for `--text-*`, `--shadow-*`, `--ease-*`, `--duration-*`.

### Step 2 — `packages/web/src/index.css`, only if you are changing the face

```css
@theme {
  --font-sans: "YourFace", system-ui, sans-serif;
  --font-display: "YourDisplayFace", serif;   /* applied to h1–h4 */
  --font-mono: "YourMono", ui-monospace, monospace;
}
```

`--font-display` defaults to `--font-sans`, so a display face is one line.

A new face must be **OFL or otherwise permissively licensed, self-hosted as a
committed woff2 subset** in `packages/web/public/fonts/`, with an `@font-face`
in the `@layer base` block of the same file. No runtime Google Fonts — the LAN
this runs on works offline. Add a `<link rel="preload">` for the primary face in
`packages/web/index.html`.

### Step 3 — `packages/web/src/components/ui/`, only where you genuinely differ

Structural departures — a squarer button, a heavier card, a different empty
state — go in the primitive, where one edit reaches every call site. If you find
yourself opening a file under `routes/` or a pane component, stop: either the
change belongs in a primitive, or you are redesigning a screen rather than
authoring a direction.

### Step 4 — verify

```bash
cd packages/web
env -u NODE_ENV npx vitest run src/styles/tokens.test.ts   # MUST be green
env -u NODE_ENV npx vite build                             # ~12s
```

The contrast guard names the exact failing pair, both resolved hex values, and
the ratio. An out-of-gamut `oklch()` is reported separately — fix it by lowering
chroma, not lightness.

### What you do NOT do

- Do not add a Tailwind colour to `@theme` that is not backed by a token.
- Do not reintroduce `tailwind.config.js`. This is Tailwind v4; configuration is
  CSS.
- Do not edit `src/lib/color.ts` or `src/styles/tokens.test.ts` to make a value
  pass. The threshold is the floor, not a suggestion.

---

## Appendix — sources

The craft floor in §5–§7 is lifted from Anthropic's `frontend-design` skill
(the three default-aesthetic clusters, the token-plan critique, the
one-signature-element rule, the advice against Inter), Vercel's web-interface
guidelines, Rauno Freiberg's interaction guidelines, and Emil Kowalski on
motion. Where they conflicted, the stricter rule won.
