---
"@paddock/web": patch
---

Allow pinning files at any depth as sibling tabs, not just top-level ones. The
"Pin as tab" affordance was gated to project-root files by two UI conditions in
the Files browser (`isTopLevel` in the file viewer and `path === ""` in the
directory listing), even though every layer beneath it already handled nested
project-relative paths — `pinFile`/`readFile`'s traversal guard, the pin REST
routes, the `pinned: string[]` model, files-subpath URL deep-linking, and the
sticky-tab persistence.

Both gates are lifted, so any file reachable through the Files page can be
pinned from its list row or its viewer; the pin stores the full
project-relative path (e.g. `design/plan.md`). A nested pinned tab shows its
basename as the visible label to stay compact, with the full path in its
`title`/`aria-label`.
