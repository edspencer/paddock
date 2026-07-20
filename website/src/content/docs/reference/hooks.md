---
title: "Hooks reference"
description: "The project.yaml schema for an event hook and the hook-management MCP tools (list_triggers / set_trigger / remove_trigger)."
---

Reference for declaring [event hooks](/concepts/hooks/). A hook is a **trigger of
type `event`**, so it's stored in a project's `triggers` block and managed through
the trigger tools. For the conceptual model and a hands-on walkthrough, see
[Event hooks](/concepts/hooks/) and [Automating with hooks](/using/automating-with-hooks/).

## `project.yaml` schema

An event hook is one entry in the project's `triggers` map, keyed by name. Each
entry is **when** (`trigger`) + **what** (`run`) + **`enabled`**:

```yaml
triggers:
  tidy-up:
    trigger:
      type: event            # discriminant: event | schedule | webhook
      on: onArchive          # for type: event — the lifecycle event
    run:
      prompt: "A chat was archived — jot a line in housekeeping.md."
      # promptFile: tidy-up.md   # XOR prompt; a .md under .paddock/triggers/, read fresh each fire
      tools: [Read, Write]   # the capability (herdctl allowed_tools); [] or omitted = tool-less
      permissionMode: acceptEdits   # default | acceptEdits | bypassPermissions | plan
      model: claude-haiku-4-5-20251001   # optional; omit to inherit the keeper default
      maxTurns: 30           # optional; default 30
      maxSpawnDepth: 0       # optional; 0 = may not spawn sub-agents
      session: new           # new (fresh chat each fire) | resume (accrete into one)
    enabled: false           # new hooks default to false (disabled)
```

Field notes:

| Field | Notes |
| --- | --- |
| `trigger.type` | `event` for a hook. (`schedule` is a time-driven trigger; `webhook` is reserved and not yet fireable.) |
| `trigger.on` | The lifecycle event. Today: **`onArchive`** (a chat is archived). |
| `run.prompt` / `run.promptFile` | Mutually exclusive. `promptFile` is a `.md` path under `.paddock/triggers/`, read fresh at fire time (git-tracked, keeper-editable); if both are set, the file wins. |
| `run.tools` | The hook agent's allow-list — its **whole capability**. Empty/omitted ⇒ a tool-less hook (reasoning only). The picker's tool names are the keeper's default allow-list (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `Bash`, `WebFetch`, `WebSearch`, `Task`, …). |
| `run.permissionMode` | Claude Code permission mode for the hook's turns. |
| `run.model` | Model override; absent inherits the keeper default. |
| `run.maxTurns` | Upper bound on agent turns in one fire. Default **30**. |
| `run.maxSpawnDepth` | Bounds the hook's own spawning of sub-chats. |
| `run.session` | `new` starts a fresh chat each fire; `resume` accretes into one owned session. |
| `enabled` | A disabled hook is stored but never fired. New hooks default **disabled**. |

A hook fires as its own agent, `trigger-<slug>-<name>` — so the tools above are
enforced by the runtime, and the chat's [capability banner](/concepts/hooks/#a-hook-run-is-a-chat-you-can-read--and-continue)
is projected from that same config.

:::note[Legacy `hooks:` block]
Event hooks first shipped under a separate per-project `hooks:` map (with
`capabilities:` and prompt files under `.paddock/hooks/`). That form still loads
and still fires on `onArchive` for back-compatibility, but the Triggers tab and
the MCP tools below read and write the unified **`triggers:`** block above — that's
the one to use.
:::

## REST surface

The Triggers tab drives these; they're here for completeness.

| Method + path | Does |
| --- | --- |
| `GET /api/projects/:slug/triggers` | List the project's triggers, plus the picker catalog: `grantableTools`, the available `events`, and `triggerTypes`. |
| `GET /api/projects/:slug/triggers/:name` | Fetch one trigger (404 if undeclared). |
| `PUT /api/projects/:slug/triggers/:name` | Create or replace one. Enable/disable is this same call with `enabled` flipped. |
| `DELETE /api/projects/:slug/triggers/:name` | Delete one. |

## Hook-management MCP tools

A keeper agent with the opt-in enabled (see `PADDOCK_HOOKS_MCP` in
[Environment variables](/configuration/environment/)) gets three
`mcp__paddock_manage__*` tools. They manage all triggers — this reference covers
the **event** (hook) shape.

### `list_triggers`

Enumerate the current project's triggers (hooks and schedules) with their
capabilities and enabled state.

### `set_trigger`

Create or update a trigger by `name` (create-or-update — there's no separate
enable/disable verb; flip `enabled`). A brand-new trigger defaults to
`enabled: false`. Arguments are flat scalars; for an event hook:

| Argument | Purpose |
| --- | --- |
| `name` | The trigger name (required). |
| `type` | `event` for a hook. |
| `event` | The lifecycle event, e.g. `onArchive`. |
| `prompt` **or** `prompt_file` | The turn's prompt inline, or a `.md` under `.paddock/triggers/`. |
| `tools` | The capability allow-list. Accepts a JSON array or a comma/newline-separated string (the CLI-runtime MCP transport can flatten arrays); empty ⇒ tool-less. |
| `permission_mode` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan`. |
| `model` | Model override. |
| `max_turns` | Turn bound (default 30). |
| `max_spawn_depth` | Bounds the hook's own spawning. |
| `session` | `new` \| `resume`. |
| `enabled` | Arm/disarm. Omit on an edit to leave the armed state unchanged. |

An edit that omits a field leaves it unchanged; supplying `prompt` clears
`prompt_file` and vice-versa (they're mutually exclusive).

### `remove_trigger`

Delete a trigger by `name`.

:::caution[The opt-in is required]
These tools are absent unless the project has opted in (`PADDOCK_HOOKS_MCP` /
per-project `hooksMcpEnabled`), and only when the self-management **write** MCP is
also on. See [Environment variables](/configuration/environment/).
:::

## See also

- [Event hooks](/concepts/hooks/) — the concept.
- [Automating with hooks](/using/automating-with-hooks/) — the walkthrough.
- [Environment variables](/configuration/environment/) — the `PADDOCK_HOOKS_MCP` opt-in.
