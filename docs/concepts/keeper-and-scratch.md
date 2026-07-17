# Keeper vs. scratch agents

Every chat in Paddock is run by a Claude Code **agent** registered with herdctl's
`FleetManager`. There are two kinds you interact with — **keepers** (one per
project) and **scratch** (one shared agent for one-off chats) — plus the
[sweeper](./sweeper.md), which is an internal per-project agent you never chat
with directly.

## Keeper — one per project

A **keeper** is the long-lived agent that owns a [project](./projects.md). It is
registered as `keeper-<slug>`, and its working directory is the project's
`workingDir` — the project dir for a notebook project, or the nested checkout for
a repo-backed one. Because Claude Code keys transcripts by working directory, **the
keeper's cwd is what ties a project's chats to that project.**

- Registered programmatically at startup and on project create/update via
  `HerdctlService.ensureProjectAgent()` (`fleet.addAgent(config, { replace: true })`
  — no yaml round-trip). See `keeperAgentConfig()` in `herdctl.ts`.
- Runs the project's default model (`project.model ?? KEEPER_DEFAULT_MODEL`, Opus
  by default) and honors the project's `permissionMode`, `maxTurns`, and
  `driveMode`.
- Allows up to `KEEPER_MAX_CONCURRENT` (10) concurrent chats, so several chats —
  and forked children — of the same project can run in parallel.
- Is the only agent that can receive the [self-management MCP](../ARCHITECTURE.md#5-mcp-injection)
  tools (env-gated), never scratch.

Because a keeper is **one shared agent per project**, a per-chat model override is
applied by re-registering the keeper (`ensureKeeperModel`) — last-write-wins
across concurrent chats of the same project. Acceptable for single-user; a clean
per-trigger override is a herdctl follow-up.

## Scratch — one shared agent for one-off chats

The **scratch** agent (`scratch`, cwd = `PADDOCK_SCRATCH_DIR`) exists for quick,
throwaway chats that don't belong to any project yet — the "just open a chat and
ask something" path. It's a single shared agent, not one-per-anything.
Scratch chats:

- Get the `send_file` MCP but **never** the self-management MCP.
- Don't trigger a [sweep](./sweeper.md) (there's no project to curate).
- Live under the scratch directory's own `.chats/`, not in any project.

## Promotion: scratch → project

A scratch chat that turns out to matter can be **promoted** into a project,
re-homing it under the keeper. `HerdctlService.promoteScratchSession(sessionId,
project)` (`herdctl.ts`, wired at `routes.ts:960`):

1. **Moves the transcript** from the scratch `.chats/` into the project's
   `.chats/`, preserving mtime.
2. **Rewrites the embedded `cwd` token** in the JSONL from the scratch dir to the
   project's `workingDir`, so a promoted chat resumes in the right place — the
   checkout, for a repo-backed project.
3. **Evicts the scratch agent's in-process session state**
   (`deleteSession(SCRATCH_AGENT, sessionId)`) so a same-process resume works.
4. **Re-attributes** the session to `keeper-<slug>` and invalidates both agents'
   discovery caches so the chat immediately shows under the project.

A related operation, `forkSession`, *copies* a session (minting a new session id)
rather than moving it — see [Chats](./chats.md).

## At a glance

| | Keeper | Scratch |
|---|---|---|
| Count | One per project (`keeper-<slug>`) | One shared (`scratch`) |
| Working dir | Project `workingDir` | `PADDOCK_SCRATCH_DIR` |
| Belongs to | A project | Nothing (yet) |
| `send_file` MCP | ✅ | ✅ |
| Self-management MCP | ✅ (env-gated) | ❌ |
| Triggers a sweep | ✅ | ❌ |
| Becomes a project chat | — | Via promotion |
