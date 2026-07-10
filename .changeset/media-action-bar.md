---
"@paddock/web": patch
---

Add a hover/focus action bar and an image lightbox to sent media embeds (#137).

Sent **images** and **PDFs** now surface a small bottom-right cluster of icon
actions over the embed:

- **Download** (`<a download>`, same-origin so it keeps the original filename),
- **Open in new tab** (`GET /api/chat-files/:id` already serves the attachment
  inline and is directly openable — no server work), and
- **Maximize** (images only) → a full-viewport **lightbox** portaled to
  `<body>`: the image at up to the window size with the filename + the agent's
  caption beneath it, **Esc** / backdrop-click to close, scroll-lock while open.

The cluster reveals on hover/focus on hover-capable devices and stays visible on
touch (reusing the `can-hover` Tailwind variant). PDFs omit Maximize — the
native `<object>` viewer already offers fullscreen/print/save, so open-in-new-tab
is the cross-browser pop-out. Everything keys off the existing `file.rawUrl`.
