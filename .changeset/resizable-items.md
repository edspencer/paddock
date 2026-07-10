---
"@paddock/web": patch
---

Bound + resize long sent-file text embeds, with a per-item height that persists across reloads (#136).

A long sent-file **code / text / markdown** embed (e.g. a 500-line code file) previously rendered every line inline and dominated the transcript. Now such an embed is wrapped in a `ResizableBox`:

- **Bounded by default:** content taller than 360px gets a fixed height with an internal scroll; shorter content is untouched (no fixed height, no scrollbar, no handle).
- **Resizable:** a subtle drag handle along the bottom edge (pointer-capture drag, double-click to reset, ArrowUp/ArrowDown to nudge) lets you set a custom height per embed.
- **Persisted:** the chosen height is saved to `localStorage` (device-sticky) and restored on render, so it survives chat switches and page reloads. The key is the file's own stable identity — a real file's immutable attachment id (from `rawUrl`), or a content hash for an inline send — which is byte-for-byte identical live and after a reload (unlike the transcript `turn.id`, which is an ephemeral counter on a freshly-sent turn and only becomes the stable uuid once reloaded).

`html` (iframe), `mermaid`, `image`, `pdf`, and `video` embeds are unchanged. Web-only; no server changes.
