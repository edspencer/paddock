---
"@paddock/server": patch
---

Four defects in project path handling and `PATCH /api/projects/:slug` are fixed
(#718, #719, #720, #721). All four live in `projects.ts` / `project-paths.ts`,
and two of them are the same underlying problem, so they are fixed together.

**`isPathInside(child, "/")` is no longer false for every child (#719).** The
`+ path.sep` that makes the helper correct everywhere else — it is what stops
`/data/projects-old` counting as a child of `/data/projects` — asked for
`startsWith("//")` when the parent was the filesystem root, so every child of `/`
reported as outside it. The separator is now appended only when the parent does
not already end in one, with unit cases for `parent === "/"` sitting next to the
`/data/projects-old` case that motivated the original form.

The consequence was that the bidirectional overlap guard in `validatePath()`
failed open in **both** directions once any project's working directory was `/`:
a second project could be created overlapping the first, and two keepers sharing
a working tree collide on transcripts, which are keyed by cwd. The same helper
backs `rmInsideRoot()`, where the bug was fail-safe (a delete was refused rather
than wrongly allowed) — so no data was ever at risk — but it is the containment
primitive from #709 and is worth being exactly right. `rmInsideRoot` now also
refuses a degenerate projects root of `/` explicitly, rather than depending on
the bug that used to make that case safe by accident.

**A project can no longer be linked at `/`, `/etc`, `/dev` or `/proc/self/cwd`
(#720).** `validatePath()` had no floor beneath which a path could not back a
project, and a linked directory becomes a keeper's cwd — running `acceptEdits`
by default. With `managed: true` (the New Project modal's "let Paddock curate
them" checkbox) that directory is also the project's `contentDir`, so the sweeper
writes `CLAUDE.md` and `CHANGELOG.md` into it.

This is a **footgun, not a privilege escalation** — anyone who can reach this API
can already create projects and run turns as whoever Paddock runs as — so the fix
is deliberately small: a denylist of system roots (`isSystemPath`), each denying
itself and everything under it, checked on the canonicalised path so a symlink
pointing at `/etc` is refused for where it really goes. `/proc/self/cwd` is
refused on the path as *written* as well, because it canonicalises to an ordinary
directory and would otherwise pass — a `/proc` path is process-relative, which a
cwd baked into every transcript path can never be. `/opt`, `/srv`, `/mnt`,
`/tmp`, `/root` and `/var` are deliberately still allowed; the alternative the
issue floated, a configurable allowed root, adds a config dimension and would
invalidate every already-linked project the day it shipped. The floor applies at
create time only, so an existing project already linked at a system path keeps
working across the upgrade.

**`repo` is immutable on PATCH again (#718).** `repo` is the third field feeding
`workingDirFor()`, alongside `path` and `managed`, which were already re-asserted
from the current record for exactly this reason. `update()` validated it with
neither `isValidRepoUrl()` (as `create()` and `promote()` both do) nor the
re-assertion, so `PATCH {"repo":"not a url at all ;rm -rf /"}` returned 200 and
relocated **both** `workingDir` and `contentDir` to `<dir>/not-a-url-at-all--rm--rf`
— a directory that does not exist. The project was left bricked: every subsequent
turn hung 60s waiting for a session file and failed, with the existing chats
stranded on the old cwd. Acquiring a repo for an existing project is what
`promote()` is for.

**Arbitrary PATCH body keys are no longer persisted verbatim (#721).**
`update()` built the next record as `{...stripDto(current), ...rest}` — the DTO
fields were stripped from the *current* value and then the untrusted body was
spread straight back in, so any invented key landed in `project.yaml` unbounded,
in a file re-parsed on every `/api/projects` call. The body is now filtered
against a `PATCHABLE_KEYS` allowlist (the runtime half of `UpdateProjectInput`,
with a `satisfies` drift guard); unknown keys are dropped and logged rather than
rejected, so a client sending a superset still works. This also closes a smaller
hole in the same shape: `pinned` is owned by the `/pins` endpoints and was
patchable here.

#718 and #721 are one fix — the PATCH route trusting its body far more than
`create()` does — covered by a regression test asserting the property that
matters: **a PATCH cannot move a project's `workingDir`**, which covers `path`,
`managed` and `repo` together.
