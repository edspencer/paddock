---
"@paddock/server": patch
"@paddock/web": patch
---

Give the project Changes tab a real route, and show untracked files' content (#107).

The **Changes** tab was local component state overlaying the URL-driven Home /
Chat / Files tabs, so it couldn't be deep-linked or bookmarked, didn't survive a
refresh, and back/forward didn't treat entering/leaving it as navigation. It now
has its own route — `/projects/:slug/changes[/:file]` — mirroring `files[/:name]`:
the active tab is derived from the URL like the other three, and a specific
changed file's diff is deep-linkable via `/changes/:file`. The sticky "last tab"
persistence learns the `changes` sub-path too.

Selecting an **untracked** file no longer shows a "No diff for this file" dead
end. `git diff` emits nothing for an untracked path, so the Changes pane now falls
back to the file's **content** — reusing the existing `GET /files/:name` endpoint
and its render-kind hint: images render as an `<img>` from the raw-bytes endpoint,
everything else renders as text (with a "new file · untracked" header). Tracked
files with a real diff are unchanged.
