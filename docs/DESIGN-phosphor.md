# `phosphor` — a visual direction for Paddock

> Read [`DESIGN.md`](DESIGN.md) first. That file is the *system*: the token
> architecture, the scales, the primitives, the craft floor. This file is one
> *direction* built on it — the argument, the decisions, and the things a future
> maintainer would otherwise undo by accident.

## The thesis

Paddock is a **Claude Code harness** — a window onto a running process. So it is
dark-first, unapologetically, and **the transcript is the product**. Everything
else is chrome around it.

Two consequences run through every decision below:

1. If a surface competes with the transcript for attention, it loses.
2. If a thing on screen is a *number*, a *path*, a *status* or an *identifier*,
   it is machine truth and it is set in the mono. If it is a sentence, it is
   language and it is set in the serif. Applied consistently, that one rule is
   most of the direction: you can tell what kind of thing you are looking at
   before you have read it.

## Colour

### The ground is glass, not black

The dark canvas is `oklch(0.283 0.028 194)` — a deep blue-green with real chroma
in it. Not near-black. Near-black plus one bright accent is the documented
default-AI dark aesthetic, and OKLCH makes it very easy to reach by accident:
**`L` is not relative luminance.** `L 0.20` renders `#10201f`, which reads as
black. A sibling direction discarded exactly that value for exactly this reason.

Light mode is the same room with the lights on: same hue (194), chroma roughly
halved, so the paper reads cool and calm rather than tinted. It is derived
separately, not by inverting the dark ramp — the bug this whole token layer
exists to prevent.

### The accent is the operator, not the product

`--accent` is a dusty rose at **H 352**. It is:

- the only warm hue on screen, and
- the only genuinely saturated thing on screen.

Everything the machine says is muted; what *you* said is lit. That is why the
operator's turn in the transcript wears it, and why a sub-agent — which used to
be accent-coloured — does not.

### A family, not an accent plus decoration

Five machine signals, respaced so no two are confusable and none of them collide
with the ground or the accent:

| token | hue | means |
|---|---|---|
| `danger` | 25 | errors, stderr, deletions, destructive actions |
| `warn` | 70 | caution, interrupted, pending, dirty |
| `success` | 150 | completed, added, connected |
| `info` | 248 | detached work: background tasks, monitors |
| `lineage` | 296 | derivation: sub-agents, forks, provenance, hunk headers |

They share **one lightness per rung per mode** (light: solid `.635`, text `.452`,
soft `.945`, border `.815`; dark: `.72` / `.815` / `.305` / `.44`). Only chroma
varies, and only enough to equalise perceived weight — blue and violet need less
than red. Five of them stacked in a column therefore read as one instrument
rather than five competing brands.

`info` sits at 248 rather than the more obvious 238 because at `L 0.452` an azure
blue is outside the sRGB gamut below about `C 0.10`, and the guard rejects it.
If you move that hue, run the guard.

### The one inversion

**`*-solid` is bright and `*-fg` is the deep glass, not white.**

A phosphor pixel glows and the screen behind it does not; a lit chip carrying
dark type is the whole metaphor in one token pair. It also measures better than
the conventional white-on-mid arrangement — 7.3:1 in dark, 5.3:1 in light — and
it means `hover` can go *brighter*, raising contrast on interaction instead of
lowering it.

**Caveat, measured.** Because `--accent-fg` is dark, the readability of the
primary button depends on how light the brand accent is. The branding seam itself
still works — every accent token derives from the three sRGB channels, and
`tokens.test.ts` proves all five follow an injected override — but the *contrast*
does not come for free. Measured `--accent-fg` on `--accent-solid`, identical in
both modes because the three channels are mode-independent:

| `PADDOCK_BRAND_ACCENT` | solid | fg on solid | on hover |
|---|---|---|---|
| **default (phosphor rose)** | `#c86a96` | **5.11:1** ✅ | **7.29:1** ✅ |
| a light brand, e.g. sky `56 189 248` | `#0ea5e9` | 6.50:1 ✅ | 8.40:1 ✅ |
| Paddock's old terracotta `194 96 60` | `#a84e2f` | 3.25:1 ⚠️ large-text only | 4.31:1 ⚠️ |
| a dark brand, e.g. navy `20 80 160` | `#11458a` | 1.92:1 ❌ | 2.30:1 ❌ |

So: the default path is unambiguously correct and *improves* on hover, a light
brand is fine, and a dark brand breaks. This is the mirror image of the
assumption a white-foreground direction makes (where a *light* brand breaks
instead) — it is not a bug, but if this direction ships it should be a deliberate
choice, and the honest fix is a luminance-aware `--accent-fg`, which CSS cannot
express portably today (`color-contrast()` is Safari-only). The cheap fallback,
if a dark brand accent is ever needed, is to set `--accent-fg` to white and
`--accent-solid` to the 600 step, giving up the lit-chip metaphor on the accent
alone while the five status hues keep it.

## Type

Two faces. Both OFL, both self-hosted as committed latin `woff2` subsets under
`packages/web/public/fonts/`, both preloaded. No runtime font request.

- **Source Serif 4** — *language*. Prose, headings, buttons, nav, help text,
  empty states. Deliberately a **low-contrast screen text serif**, not a
  high-contrast display serif: the latter, on a cream ground with a terracotta
  accent, is a documented default and a different direction's problem.
- **Spline Sans Mono** — *machine truth*. Identifiers, paths, slugs, tool names,
  counts, timestamps, statuses, exit codes, code, diffs. A humanist mono, narrow
  enough for the density this direction is designed around.

The rule is applied at the **primitives**, not at call sites — `.status-pill`,
`.tag`, `.field-label`, `.section-label`, `.input`, `select`, and the `Section`
card title are all mono because of what they *are*. That is what stops the rule
decaying the moment someone adds a screen.

Agent prose gets a hard **74-character measure** applied to the blocks, not to
the container, so a paragraph stays readable while a code block, a diff or a wide
table still gets the full pane.

## Form

High density, because the design target is someone with seven projects and
thousands of chats, not an empty demo. Radii tighten by about a third
(2/3/5/7/9/12px) but deliberately **do not go to zero** — zero radius plus
hairline rules is the broadsheet default, and it belongs to a different
direction. Concentricity is preserved.

## The signature element: the transcript, rebuilt

`packages/web/src/components/chat/Transcript.tsx`. This is where the boldness
went; everything else is quiet on purpose.

**Chat bubbles are gone.** A transcript is a log, not a conversation between
peers, and a log is one column.

- **The operator's turn** is a full-width record with a rose rail and a mono
  `YOU` eyebrow. It is marked by *colour and structure*, not by alignment — which
  is what lets it survive being one row among three hundred.
- **The agent's prose** sits directly on the glass: no card, no ring, no bubble.
  A transparent left border keeps its text edge flush with every marked record
  above and below it. Reading a long answer is what people actually do here.
- **Consecutive tool calls collapse into ONE record block.** This is the change
  that matters. A single turn routinely runs a dozen Reads, Greps and Edits;
  rendering each as its own floating card gives you twelve borders, twelve
  shadows, twelve different left edges and no way to compare the twelfth to the
  first. Instead: one hairline-ruled block, and each row a fixed four-column grid

  ```
  rail | kind (6rem)  | subject (1fr, truncates)     | metadata (auto, tabular)
  ▏    | Read         | packages/web/src/index.css   | lines 1–787         6ms
  ▏    | Edit         | project-files.ts             | +36 −18            29ms
  ▏    | Agent        | Implement #516 Phase 6       | 57m 42s        ~$35.35
  ```

  so twelve tool calls read as a twelve-row table you can scan down, with a
  column of durations you can actually compare.
- **The rail encodes state before you read anything**: violet = a sub-agent,
  blue = detached/background, red = failed, rose = Paddock acting on itself.
  Every one of those is also carried by a distinct icon, so the encoding is never
  colour-only.
- **A running sub-agent tints its whole row** rather than spinning something.
  Persistent state should be a colour you can see from across the room, not an
  animation you have to catch.
- **Nested sub-agent logs recurse through the same grammar** under a violet rule,
  to any depth. There is no second visual language for nesting.

### The thing taken off

Every row used to carry a chevron. Three hundred identical glyphs telling you
something the block's own shape already tells you. The chevron keeps its grid
column — so there is no layout shift — but only paints on hover, focus or when
the row is open, and `aria-expanded` carries the state for anyone not looking at
pixels.

## Reject this

- A near-black canvas. If `--surface` in `.dark` drops below about `L 0.26`, or
  its chroma below about `0.02`, this direction has become the default it was
  built to avoid.
- A second saturated hue competing with the accent. The accent means *the human*.
  If a machine affordance starts wearing it, the whole scheme stops meaning
  anything.
- Putting the accent back on sub-agents. They are `lineage`, and that is a
  statement: the machine deriving from itself.
- Setting a sentence in the mono, or a status value in the serif. The rule is the
  direction.
- Re-introducing a card around the agent's prose.
- Adding a third typeface.
