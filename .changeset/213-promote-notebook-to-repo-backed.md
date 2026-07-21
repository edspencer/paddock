---
"@paddock/server": minor
"@paddock/web": minor
---

Promote a **notebook** project into a **repo-backed** one _in place_ (#213),
preserving its chats and sidecar metadata. Repo-backing was previously set only at
creation (`repo` immutable, #187/#194); this relaxes that on one path so a
history-rich notebook can attach an external git repo without a teardown/recreate.

`ProjectStore.promote(slug, repo)` clones the repo into the nested `.gitignore`d
checkout (clone-first with rollback — a clone failure leaves the notebook wholly
intact), sets `repo:` in `project.yaml` (flipping the keeper's cwd to the checkout so
the repo's own `CLAUDE.md`/git/PR flow apply), writes the sidecar `.gitignore`
(`/<repo-name>/` + `/.chats/`), and removes the notebook's sweeper-owned `CLAUDE.md`
(the repo's own takes over). Existing chats need no transcript surgery: they already
live in `.chats/`, and re-registering the keeper re-symlinks the new cwd's encoded
transcript path at that same store, so every chat stays listed and resumable.

Surfaced as `POST /api/projects/:slug/promote` and a two-step-confirm "Repository
backing" section in the project Settings tab (a repo-backed project shows its backing
read-only — promotion is one-way).
