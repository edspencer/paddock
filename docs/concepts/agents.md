# Agents

Every chat in Paddock is run by a Claude Code **agent** registered with herdctl's
`FleetManager`. There is one kind you interact with — the per-project agent that
runs Claude in the project's directory — plus the [sweeper](./sweeper.md), which
is an internal per-project agent you never chat with directly.

> **This page used to be "Keeper vs. scratch agents".** Paddock had a second,
> shared `scratch` agent for one-off chats that belonged to no project. #516
> retired it: the root of the instance is now [a workspace like any
> other](./projects.md), so a chat that belongs to no *particular* project is
> simply a chat of the root workspace, run by an ordinary agent. Every capability
> scratch was deliberately denied — the self-management MCP, curation, triggers,
> attachments, run history, a CLAUDE.md that actually reaches it, more than one
> turn at a time — a root chat has for free.

## One agent per project

Each [project](./projects.md) has one long-lived agent, and its working directory
is the project's `workingDir` — the project dir for a notebook project, or the
nested checkout for a repo-backed one. Because Claude Code keys transcripts by
working directory, **that cwd is what ties a project's chats to that project.**

- Registered programmatically at startup and on project create/update via
  `HerdctlService.ensureProjectAgent()` (`fleet.addAgent(config, { replace: true })`
  — no yaml round-trip). See `keeperAgentConfig()` in `herdctl.ts`.
- Runs the project's default model (`project.model ?? KEEPER_DEFAULT_MODEL`, Opus
  by default) and honors the project's `permissionMode`, `maxTurns`, and
  `driveMode`.
- Allows up to `KEEPER_MAX_CONCURRENT` (10) concurrent chats, so several chats —
  and forked children — of the same project can run in parallel.
- Can receive the [self-management MCP](../ARCHITECTURE.md#5-mcp-injection)
  tools (env-gated).

Because it is **one shared agent per project**, a per-chat model override is
applied by re-registering that agent (`ensureKeeperModel`) — last-write-wins
across concurrent chats of the same project. Acceptable for single-user; a clean
per-trigger override is a herdctl follow-up.

> **The `keeper-` name prefix.** A project's agent is registered as
> `keeper-<slug>` — a legacy encoding from before "keeper" was retired as a
> concept. That exact string is persisted in herdctl job records, `state.yaml`,
> session directories and Paddock's sidecar stores, so renaming it would orphan
> all of them; it stays. Read it the way you read `_root` below: an opaque
> identifier in the herdctl agent namespace, not a name for anything you interact
> with.

## The root agent

The root workspace's agent is `keeper-_root`, and its working directory is
`projectsRoot` — the directory that *contains* every project. (The workspace's
own key is `""`; `_root` is how that key is spelled in the agent namespace, which
cannot hold an empty name.) It is an ordinary agent in every mechanical respect,
but worth calling out plainly: **its cwd
contains every project, so a root chat can read and edit any project's files, and
root's git status is the whole backing repo.** That is the intent — the root is
where you act across the instance — but it is a real escalation over a project
agent, which is confined to its own subtree.

Its chats live at `/chat` and in `<projectsRoot>/.chats/`.

## Promotion: giving a chat its own project

A chat that turns out to matter can be **promoted** into a project of its own,
re-homing it under that project's agent.
`HerdctlService.promoteSession(sessionId, from, to)` (`herdctl.ts`, wired at
`POST /api/projects/:slug/chats/:sessionId/promote`):

1. **Moves the transcript** from the source project's `.chats/` into the new
   project's `.chats/`, preserving mtime.
2. **Rewrites the embedded `cwd` token** in the JSONL to the new project's
   `workingDir` — the checkout, for a repo-backed project. (Resume does not
   depend on this: Claude Code keys resume on where the transcript *is*, not on
   its recorded `cwd`. The rewrite keeps the file honest about itself.)
3. **Evicts the source agent's in-process session state**
   (`deleteSession(keeper-<from>, sessionId)`) so a same-process resume works.
4. **Re-attributes** the session to `keeper-<to>` and invalidates both agents'
   discovery caches so the chat immediately shows under the new project.

The UI offers this on **root** chats — the ones that belong nowhere in
particular, which is exactly the population promotion was invented for. The
server route is generic.

A related operation, `forkSession`, *copies* a session (minting a new session id)
rather than moving it — see [Chats](./chats.md).
