---
"@paddock/server": patch
---

Repo-backed projects now do a **full clone** (not `--depth 1`). A repo-backed
project is where you do engineering, so the keeper should have real history —
`git log`, blame, bisect, and a non-shallow base for branches/PRs — from the
moment the project is created.
