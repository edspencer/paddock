---
"@paddock/server": patch
"@paddock/web": patch
---

Add an inline video player for files shared via `mcp__paddock__send_file` (issue #126). An agent can send a screen recording (e.g. a Playwright `recordVideo`) via `file_path` and the user sees a playable `<video>` with controls that survives page reload. The chat-file endpoint (`/api/chat-files/:id`) now supports HTTP byte ranges (`206 Partial Content`), which is what makes mobile Safari / iOS play a `<video>` at all; video is served with a plain `default-src 'none'` CSP (no `sandbox` token) so nothing interferes with playback. `.mp4`/`.webm`/`.mov`/`.m4v` infer the `video` kind (the image check still runs first so `.webp` is never confused with `.webm`), and the attachment size cap is raised to 100 MB. No new dependencies.
