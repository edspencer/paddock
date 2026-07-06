---
"@paddock/server": minor
"@paddock/web": minor
---

feat: configurable per-instance branding — title, logo, accent color (#34)

Running several Paddock instances side by side (Projects, Homelab, House, …)
now lets each be told apart at a glance. Three new env vars, all optional with
defaults that preserve today's look (🐎 / "Paddock" / terracotta):

- `PADDOCK_BRAND_NAME` — the wordmark + browser tab title.
- `PADDOCK_BRAND_LOGO` — the logo glyph/emoji, or a URL/absolute path to an
  image (rendered as an `<img>`).
- `PADDOCK_BRAND_ACCENT` — the accent color (hex) driving the primary buttons
  (New Project / New Chat) and the logo chip.

Branding is **runtime** config (one image serves every instance): the server
injects it into `index.html` at serve time — a `window.__PADDOCK_CONFIG__`
global plus a `:root` accent override — so there's no title/color flash before
first paint. The accent moved from build-time Tailwind constants to CSS custom
properties (`--accent*`, kept as RGB channels so opacity modifiers like
`bg-accent/15` still work); the 600/700 hover shades are derived from the base.
