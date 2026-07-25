---
"@paddock/server": minor
"@paddock/web": minor
---

Self-management MCP: add `create_project` so a keeper can provision a project (#467)

Keepers could create chats inside an existing project but never the project itself,
so agent-driven setup always stopped to ask a human to click **New project** (and an
on-box `curl` to `POST /api/projects` has no credential on a JWT instance).

`create_project` takes `name` (required) plus optional `slug`, `repo`, `summary`,
`area` and `status`, and returns the new slug, working dir and whether it is
repo-backed. Passing a `repo` git URL creates a repo-backed project — cloned into a
nested checkout that becomes the keeper's cwd, with the existing rollback-on-clone-
failure behaviour, so a bad URL leaves no half-made project behind. Under the hood it
calls the same `ProjectStore.create` + `ensureProjectAgent` pair `POST /api/projects`
does, so the REST and MCP paths can't drift.

Gated behind a new instance flag `selfMcpProjectsEnabled` / `PADDOCK_SELF_MCP_PROJECTS`
(default OFF, only honoured when the self-MCP write tools are also on). It gets its own
switch rather than riding on `selfMcpWriteEnabled` because — unlike every other write
tool — it creates instance-level state and clones a caller-supplied git URL. Existing
deployments see no change to their tool surface.
