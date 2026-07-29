---
"@paddock/server": minor
"@paddock/web": minor
---

The root is a workspace, not a project with a magic slug

Replaces the `__root` sentinel with a **workspace** model keyed by the path
relative to `projectsRoot`. The root workspace's key is the empty string — the
zero value already in the key space, not a reserved name — so `path.join(root,
"")` resolves it and the resolution seam stops branching. Both copies of
`dirFor` are now the same one-liner, which makes the class of bug that shipped in
v0.49 (one copy missing the branch, 404ing every root file route) structurally
impossible.

**The root workspace always exists.** No `project.yaml` gate, no creation
endpoint, no enable card, and no `Project not found: __root` when you click New
chat on a fresh instance. `GET`/`POST /api/root-project` are gone; the root's
defaults are derived (its name is the projects-root directory basename) and a
record is written lazily, only when a setting actually changes.

**Workspace-scoped routes are now mounted twice** — `/api/root` (key `""`) and
`/api/projects/:slug` — from a single Fastify plugin. Same handlers, same
schemas, same error paths, so "the root behaves like a project" holds by
construction rather than by discipline.

`/` is the root workspace's Home, and the projects grid is its children tab at
`/projects`.

Also fixes three latent bugs the empty key exposed, all the same falsy-vs-absent
mistake: a chat whose parent was a root chat had its recorded parent edge
discarded (falling through to the inference tier and rendering as an orphan);
root chats were skipped by the recovery nudge, silently disabling Continue and
auto-re-drive; and root chats were dropped from the per-workspace unread badge.
