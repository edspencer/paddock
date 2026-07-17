---
"@paddock/server": minor
"@paddock/web": minor
---

Changes tab: selective per-file commit, diff stat, and a projects-grid dirty nudge (#258)

- The Changes tab now has a checkbox per changed file (with select-all/none) and a "Commit N selected" action, so you can commit a subset instead of the previous all-or-nothing commit. `GitService.commitProject` gains an optional project-relative `paths` list (validated to stay inside the subtree); the commit endpoint accepts `files[]`.
- Each changed file shows a `+A −R` line stat (from `git diff --numstat` for tracked changes, all-added line counts for untracked text files, "binary" for binary), echoed in a diff stat header.
- The projects grid now flags each project's uncommitted-file count, fed by a single cheap `git status` rollup on `/api/projects` — so pending work is visible before opening a project.
