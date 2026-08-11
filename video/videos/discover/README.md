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
