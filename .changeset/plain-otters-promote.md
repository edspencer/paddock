---
"@paddock/server": minor
---

Self-management MCP: add `promote_project` (notebook → repo-backed) (#470)

`POST /api/projects/:slug/promote` (#213) has been able to turn a notebook
project into a repo-backed one in place since long before agents could drive
Paddock — but there was no MCP verb for it, so an agent that realised its
notes-only project should have been a codebase had to stop and ask a human. It
could `create_project` a *second*, repo-backed project and abandon the first,
which loses the chats.

`promote_project` takes a required `repo` git URL plus an optional `project`
slug (defaulting to the current project, so an agent can promote the workspace
it is running in). It clones the repo into the project's nested checkout, flips
the agent's working directory to it, and re-registers the agent — which
re-symlinks that new working directory at the project's existing `.chats/`
store, so every chat stays listed and resumable.

Under the hood it calls the same `ProjectStore.promote` + `ensureProjectAgent`
pair the REST route does, in the same order, so the two paths can't drift.
Every guard stays in the store: an already-repo-backed project is refused, so is
the root workspace, and a failed clone rolls back to a byte-identical notebook.
Server filesystem paths are stripped from a clone error before the agent sees it.

It rides on the **existing** `selfMcpProjectsEnabled` / `PADDOCK_SELF_MCP_PROJECTS`
flag rather than getting a third one — same blast-radius class as
`create_project`, and an operator who has granted "this agent may provision
projects" has already made the decision promotion asks for. No new config, and
no change to the tool surface of an instance that hasn't opted in.
