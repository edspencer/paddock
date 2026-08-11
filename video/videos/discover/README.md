# discover — the Discover clip (~19s)

Ships as `website/public/demo/discover.mp4` + `discover-poster.jpg`, for the
**0.68 What's New entry, which currently has no image at all**. Discover is a
*process* — scan, list, choose, import, projects appear with their
conversations — and a still can only ever show one frame of it.

> Depends on the video harness in `video/lib/`, which is **not on `main`** — it
> is PR #584, branch `video/demo-harness`. Get it with
> `git worktree add <path> origin/video/demo-harness`; do not merge it here.

```bash
# 1. a rig, with a PRESENTABLE home (see below)
pm start <name> --cwd <built-clone> -- <your launcher>
# 2. projects, then discovery candidates
env -u NODE_ENV PADDOCK_RIG_HOME=$RIG node tools/docs-media/seed.mjs --base $BASE
env -u NODE_ENV PADDOCK_RIG_HOME=$RIG PADDOCK_RIG_DEMO_HOME=/home/mara \
  node video/videos/discover/seed-discover.mjs
# 3. shoot — ORDER MATTERS, see below
env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  node video/videos/discover/scenes/scene1.mjs land
#   …then choose, then import, then chat
# 4. cut
env -u NODE_ENV node video/lib/assemble.mjs \
  video/videos/discover/manifest.mjs --name discover --no-gif
# 5. prove it
env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  PADDOCK_LEAK_EXTRA='<your box patterns>' node video/videos/discover/leakscan.mjs
```

## The three things that will catch you out

**1. The rig's `HOME` must really be at a presentable path.**
`/discover` renders candidate directory paths as the largest text on the page —
they *are* the subject, so they cannot be cropped or masked. With the rig home
under `/data/...` the frame reads
`/data/paddock-servers/<rig>/home/code/harbour-charts`, which is unshippable.
Symlinking a pretty path at the real storage does **not** fix it: Paddock
canonicalises for display, so the UI resolves the symlink, shows the real path,
and the leak masker then blanks it — leaving a hole where the subject should be.
`tools/docs-media/serve.sh` hard-wires `HOME="$PADDOCK_RIG_HOME/home"`, so this
clip needs a launcher that sets `HOME` separately from the data dir. Keep the
**data dir and Claude home on persistent storage** even when `HOME` is not: only
the throwaway candidate directories should live on the ephemeral half, because
re-seeding those is one command.

**2. Shot order is load-bearing, and getting it wrong fails silently.**
Import is one-way: it consumes the candidates. `land` and `choose` must be
recorded **before** `import`. Shoot them after and you get a correctly-rendered
empty list, no error, no warning.

**3. Restoring the pre-import state needs more than deleting the projects.**
Two things outlive the import:

- adoption writes an **adopted-sessions record keyed on session id**, so those
  ids are classified `attributed-to-run` for ever and never come back as
  candidates. `seed-discover.mjs` takes `SEED_OFFSET` to mint genuinely new
  sessions; that, not the project delete, is what restores the empty state.
- the import **symlinks** `<claudeHome>/projects/<encoded>` at the new project's
  `.chats`. Deleting the project leaves a **dangling symlink** behind, and the
  next seed then fails with a bare `ENOENT` on `mkdir` that names a path which
  visibly exists. Clear dangling links first.

## Continuity note

Selection is client state, so every `record()` call starts with all candidates
ticked again. The `import` shot therefore **re-does the untick off camera** and
is trimmed in after it. Without that the film cuts from "Import 2 projects" to a
result reading "3 projects, 9 conversations" — the count jumps back up across
the join, which is the kind of error that is invisible while you are shooting
and obvious to everyone afterwards.

## Do not touch

The **"Also offer directories outside `/home/mara`"** toggle. The hidden
directories are earlier seed attempts under the rig's real `/data` path;
flipping it puts host paths on screen in the largest type on the page. The
toggle is deliberately left in frame — it is real UI and its OFF state is
honest — but the cursor never goes near it.

## Captions

Taken from the UI's own words wherever they make a promise. The screen says
*"Importing one links it as a project and copies its conversations in; your own
history is never moved or deleted"*, so the caption is **"Never moved, never
deleted"** — not the storyboard's *"Nothing is cloned. Nothing is written into
your directories"*, which overstates it in one direction (conversations **are**
copied into Paddock) and is vaguer in the other.

## Leak check — the two rules that make `leakscan.mjs` worth reusing

### 1. A viewport-restricted scan is only valid for the scroll positions the film visits

Most Paddock routes carry host paths **below the fold** — the Advanced
(read-only) section of `/config`, a project's working directory on its Home tab.
A whole-document `innerText` scan reports those and is right to; but a leak that
never enters the viewport cannot enter a frame. Treating a document-wide hit as
disqualifying blocks publishable footage; ignoring it ships a leak the moment
something scrolls. So `leakscan.mjs` classifies every hit as **onscreen** or
**offscreen** and fails only on the first.

**The catch is that "onscreen" is measured at one scroll offset.** The
accent-picker clip never scrolls, so scanning at `scrollY: 0` alone was a
complete proof for it. **That does not transfer.** Any film with a scroll,
an expanding row that pushes content, or a route whose list outgrows the
viewport must be scanned at **every position the camera actually reaches** —
otherwise the scan is answering a question about a frame that was never shot.
Scan the positions the film visits, not the page.

### 2. The control string must exercise the MATCHER, not just the traversal

A scanner that can only ever report "clean" is indistinguishable from a working
one, and reads as reassuring. So every run asserts a string it **must** match,
and throws if it does not.

Be deliberate about which failure the control catches:

- a control proving *text was read at all* (this file's `"Paddock"` check)
  catches a broken DOM walk — a wrong root, a detached document, a page that
  had not painted;
- a control proving *the pattern discriminates* — feeding the `LEAK` regex a
  string it is required to match, e.g. `"path is /data/somewhere"` — catches
  the more dangerous failure: a regex that is silently wrong, over-escaped, or
  built from an empty `PADDOCK_LEAK_EXTRA`, and therefore matches nothing.

The second does not follow from the first. A perfect traversal fed to a broken
pattern reports clean on a leaking page, and the run looks exactly like a pass.
**Assert both.**

As shipped, this file's control does the **first** job only: `leakscan.mjs`
computes `control: seen.join(" ").includes("Paddock")` and throws if it is
missing. That is a plain substring test over the collected text — it never runs
the leak regex. So it fires when the DOM walk collects nothing, which is a real
failure worth catching, and passes unchanged when a leak *pattern* is malformed.
Adding a matcher-side control is the outstanding improvement.


And the standing one: **`strings clip.mp4` is not a leak check.** Rendered text
is pixels, so a frame containing a live token greps clean. Scan the DOM, and
watch the finished clip.
