---
"@paddock/server": minor
"@paddock/web": minor
---

feat(#239): render image `Read` results inline in the expanded tool block

Expanding a `Read` of an image (`.png`/`.jpg`/…) previously showed `(no output)` — Claude Code returns an image content block, which herdctl renders as empty text. Building on #237's `Read` enrichment, the server now flags an image read (`readInfo.isImage`) and, when the file resolves **inside the project dir**, exposes a project-relative path (`readInfo.projectRelPath`); the web renders the image inline via the existing raw file endpoint (`/api/projects/:slug/files/:name?raw=1`, the same one the Files tab uses), height-capped and click-to-open at full size.

History-hydrated only, no herdctl change. An image outside the project dir, or a scratch chat (no servable file endpoint), degrades to the generic block. Path resolution is guarded twice — a `..`/absolute relative path is rejected in the enrichment, and the raw endpoint re-guards traversal against the project dir.

The inline image treatment is now a shared `InlineImage` component used by BOTH an image `Read` and an agent-sent image (`send_file`): a hover action bar (download / open-in-new-tab / maximize) and a full-screen lightbox, with the image itself click-to-maximize (zoom cursor) so you don't have to hunt for the maximize icon.
