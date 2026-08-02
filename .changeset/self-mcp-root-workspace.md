---
"@paddock/server": patch
---

The self-management MCP surface can now see and reach the **root workspace**
(#560). Root chats were unlistable and unreadable — a keeper (or an external
`/mcp` client) could not reach a single one.

A workspace key is a path relative to `projectsRoot`, so the root's key is the
empty string, and every workspace key on this surface was tested for
_truthiness_. Two of the three failures were silent:

- `list_chats {"project": ""}` named an explicit target and got a **different**
  target's answer — the empty key collapsed into "no filter", so it listed every
  _project's_ chats (and then reported zero, since no project owns a root chat).
- `read_chat {"project": "", …}` answered `` `project` … is required `` for an
  argument that **was** supplied.
- `list_projects` gave a caller no way to learn the root existed at all.

Fixed the way REST already solves it — reach the root by key, never by widening
enumeration. `ProjectStore.list()` is unchanged: it still walks children only.

Three behaviour changes to the tools:

- **`list_chats` with no `project` now covers the root as well as every
  project.** It is the only source of session ids, so omitting the root made
  root chats undiscoverable. Root chats report `project: ""` — pass that value
  back to `read_chat` verbatim.
- **`list_chats {"project": ""}` and `read_chat {"project": ""}` now address the
  root workspace** instead of misfiring. An _absent_ `project` still means "all
  workspaces" for `list_chats` and is still a hard error for `read_chat`.
- **`list_projects` gained a `root` field** — the root workspace, mirroring the
  `{ projects, root }` shape `GET /api/projects` settled on. It is deliberately
  **not** in `projects` or `count`: the root is not a project. `root` is `null`
  for a client whose scope doesn't reach it.

The `project` descriptions/schemas on `list_chats`/`read_chat` now name the
empty key, replacing text ("Omit to list chats across all projects") that was
itself part of the confusion. Scoping is unaffected: a client's `projects`
patterns are matched against `""` like any other key, so a narrowly-scoped
client still sees no root chats.
