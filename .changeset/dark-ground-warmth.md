---
"@paddock/web": patch
---

Restore the dark theme's warmth. The token pass neutralised the dark ground —
the assistant prose card's chroma fell from 0.017 to 0.0075 at hue 88 rather
than the old ramp's 67–77 — so a palette that read as brown started reading as
grey. `--surface` and `--surface-raised` are back to the pre-token UI's measured
values (`#141210`, `#28221a`), sampled from a screenshot of it rather than
recovered from the config, and verified against rendered pixels.

Accent text in dark mode was being lifted 26% toward white, turning the
terracotta into a salmon (`#c2603c` → `#d58a6f`). The lift is now the minimum
that clears 4.5:1 against **every** dark surface — 14%, giving `#cd7758`. The
raw accent cannot be restored as text: it measures 3.77:1 on the prose card and
3.5:1 on the active surface, so a literal restoration would have made contrast
worse, not better.

Accent fills and borders are restored exactly, which required mixing them in
sRGB rather than OKLab: the old sub-agent strip was `bg-accent/10` composited
over the page, and only an sRGB mix lands on that same pixel (`#251a14`).
`resolveColor` in `lib/color.ts` gains `in srgb` support so the contrast suite
can evaluate those tokens.

All 79 contrast pairs still pass in both modes. Light mode is untouched.
