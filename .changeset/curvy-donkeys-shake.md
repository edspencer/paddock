---
"@paddock/server": patch
"@paddock/web": patch
---

Fix the Changes tab and file browser for projects whose working directory isn't
their metadata directory — a linked git worktree, a linked checkout, or a
repo-backed clone (#710).

Verifying that a `path:` may point at a git **worktree** confirmed most of the
surface already works: `status`, `diff` and `commit` act on the worktree, the
branch shown is the worktree's own (`feature-x`, not the main checkout's `main`),
a commit lands on that branch and leaves the main checkout untouched, and the
grid's "N uncommitted" badge already covers linked projects via `dirtyCountAt`.
Three surfaces had been left behind, each failing silently:

- **A new file in the Changes tab rendered "File not found."** The pane shows an
  untracked file's content in place of a diff (it has no diff), and fetched it
  from `/files/:name` — the metadata-dir browser. For any project whose working
  directory is elsewhere that is the wrong directory, so *every* untracked row
  404'd. The pane now reads a new `GET /api/projects/:slug/git/file`, served from
  the working directory and gated on git's own answer: a path `git status`
  reports as untracked, and nothing else.

  That gate is deliberately not the dot-segment guard the notes browser uses,
  which is wrong here in both directions. It **under-blocks**: a worktree's
  `.git` is a *file*, so it is a leaf, and a dotfile leaf is deliberately allowed
  (an untracked `.gitignore` has to render) — serving it would disclose the main
  checkout's gitdir path. And it **over-blocks**: a brand-new
  `.github/workflows/ci.yml` is an ordinary row the pane lists and must be able
  to render. Git never reports `.git`, and never reports an ignored file, so the
  servable set is exactly the set the pane already displays.

- **The Push button pushed the wrong repository.** Remote state and push were
  still fleet-level — the backing store — while the header beside them showed the
  project's own branch. On a linked project that meant a branch label, an
  ahead-count, a remote URL and a Push button describing two different repos.
  `GET /api/projects/:slug/git/remote` and `POST /api/projects/:slug/git/push`
  are per-project now, and the pane uses them; the GitHub device-flow connection
  stays fleet-level and rides along in the same payload. A notebook project
  resolves to the same repository it always did.

- **A managed project with a `path:` had an empty Files tab.** Its curated
  `CLAUDE.md` / `OVERVIEW.md` / `CHANGELOG.md` live out at that path, but the
  browser joined `projectsRoot + slug` and listed a directory holding only
  `project.yaml`. It now browses the project's content dir — the same resolution
  the sweeper writes through. Unmanaged and notebook projects are unchanged, and
  the notes surface keeps its dot-segment guard.
