---
"@paddock/web": patch
---

Restore the inline-code highlight and the blockquote colour in rendered markdown

Inline `code` in a chat message had lost its background: the chip borrowed
`--surface-active`, and when v0.68.0's colour restoration raised
`--surface-raised` to the pre-token prose card, the gap between the chip and the
card it sits on closed to 1.04:1 — invisible. Blockquotes had gone grey for a
different reason: they take `--text-muted`, whose chroma the token migration
dropped from 0.059 to 0.015 at the same hue.

Both roles now have tokens of their own (`--code-fill`, `--quote-text`,
`--quote-border`), set to the measured values of the pre-token UI. The chip
cannot simply ride `--surface-active` again — that token is pinned by
`--text-subtle`, which would fall to 3.95:1 on the lightness the chip needs —
which is why these are separate rather than a re-tuned ladder. Parchment,
Terminal and Sci-Fi alias the new tokens back to the ladders and are unchanged.
`tokens.test.ts` and `themes.test.ts` now assert the chip stays visible on the
prose card in every theme, so a surface moving underneath it fails the build.
