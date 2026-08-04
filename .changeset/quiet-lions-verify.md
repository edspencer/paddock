---
"@paddock/server": patch
---

Only offer a same-named directory for import if it really is a clone of the repo

For a repo-backed project, the import offer matched any transcript folder whose
recorded working directory had the same BASENAME as the project's checkout —
anywhere on disk. On the dogfooding instance the `hushpod` project was
consequently offering 15 chats out of
`/data/scratch/paddock-video/data/projects/hushpod`: a throwaway QA instance's
data directory, matched purely on leaf name and belonging to a different Paddock
instance entirely.

A same-named directory now has to prove it is a clone of the project's repo. Its
git remotes are compared against `project.repo`, normalised so that the same repo
addressed different ways still matches:

    https://github.com/acme/api.git  ┐
    git@github.com:acme/api          ├─ all → github.com/acme/api
    ssh://git@github.com/acme/api/   ┘

Any configured remote counts, not just `origin`, so a contributor whose `origin`
is their fork and whose `upstream` is the project's repo still matches. Linked
worktrees are handled (`.git` is a file; the config lives in the main repository's
git dir behind a `commondir` pointer).

The original reason for not checking the remote was cost — running git in every
candidate directory, behind a count rendered in a header. Nothing shells out
here: the remote is read from `.git/config`, only for directories that already
passed the basename test, memoised on that file's mtime and size.

A candidate with no readable git config, or whose remotes all point elsewhere, is
no longer offered. The project's own working directory is exempt and always
offered, so a project whose checkout has an unusual remote keeps its own history.
