---
"@paddock/server": minor
"@paddock/web": minor
---

feat(projects): repo-backed project type (#187)

Add a second project type: a project **linked to its own external git repo**,
cloned as the keeper's working directory — the natural unit for doing engineering
(vs. the notebook project, which is a directory in the instance data repo).

- **Data model:** a `repo:` URL in `project.yaml` marks a project repo-backed;
  the DTO gains `workingDir`, `repoBacked`, and `repo`. Set at creation, immutable.
- **Clone-on-create:** Paddock clones the repo into a nested `.gitignore`d checkout
  under the project dir and sets the keeper's cwd to that checkout — so the repo's
  **own** `CLAUDE.md`, git history, branches and PR flow work natively (verified
  end-to-end: a keeper turn's `pwd` is the checkout and it reads the repo's CLAUDE.md).
  A clone failure rolls the half-created project back.
- **Sweeper split:** `OVERVIEW.md` + `CHANGELOG.md` are still curated for both types,
  sidecarred in the metadata dir (never written into the checkout). The per-project
  `CLAUDE.md` is **notebook-only** — a repo-backed project defers to the repo's own,
  which the sweeper never touches.
- **Transcripts** stay in the metadata dir even when the cwd is the checkout, so they
  never pollute the external repo's working tree.
- **Web:** a "Git repository URL (optional)" field in the New Project modal and a
  "Repo" badge (+ Home metadata row) on repo-backed projects. Also fixes the modal
  swallowing create errors (a failed create now shows the message and keeps the form).

Follow-ups (documented, out of scope): per-repo scoped credentials for private
repos / push / PR (OpenBao), and DR re-clone on rebuild.
