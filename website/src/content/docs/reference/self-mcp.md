---
title: "Self-management MCP (`paddock_manage`)"
description: "The in-process toolset Claude uses to drive Paddock itself: all 14 paddock_manage tools with their arguments and return shapes, and the four instance flags plus maxSpawnDepth that decide which of them exist."
---

Claude can drive **Paddock itself** — enumerate projects, read another chat's
transcript, spawn and fan out new chats, provision a project, manage a project's
triggers — through an MCP server Paddock injects into Claude's own turn. The
server key is **`paddock_manage`**, so the agent sees each tool as:

```
mcp__paddock_manage__<tool>
```

There are **15 tools** across four capability tiers. Every tier past the first is
**off by default**; a stock instance grants nothing here at all.

:::caution[These tools are a capability grant, not a convenience]
Six of them (`create_chat`, `fork_chat`, `fork_chat_batch`, `send_message`,
`run_trigger`, `set_trigger`) **start real turns**, and Claude runs with `Bash`
and `Write`. `create_project` and `promote_project` run `git clone` on a URL the
*agent* chose. Turning on the write tier is a deliberate decision about blast
radius — which is exactly why it is a separate flag from the read tier, and why
the project tools have a flag of their own on top of that.
:::

## How it reaches the agent

Paddock builds an `InjectedMcpServerDef` per turn and hands it to herdctl as
`injectedMcpServers`, and herdctl auto-allowlists the server's `mcp__<key>__*`
tools. How the def reaches the agent depends on the runtime: a chat runs on the
Claude Agent SDK (the `session` drive-mode default), where the def becomes an
**in-process SDK MCP server**; the sweeper, triggers, and `driveMode: batch`
chats run as a separate `claude -p` process that can't reach an in-process server,
so herdctl stands up a **localhost HTTP MCP bridge** per injected server instead.
Either way nothing crosses the network, nothing is authenticated, and no static
`allowedTools` change is needed.

Two consequences worth internalising:

- **The toolset is assembled per turn, not per instance.** Which tools exist is
  decided when the turn is dispatched, from the flags below plus the project the
  chat lives in. A gate that is off means the tool is **absent** from
  `tools/list` — never present-and-refusing.
- **Arguments are flat scalars.** The CLI-runtime MCP transport proved unreliable
  at carrying array-typed arguments, so list-shaped inputs (`prompts`, `tools`)
  are declared as **strings** and accept either a newline/comma-separated list or
  a JSON array. Chats run on the SDK runtime now, but the flat shape is kept — the
  same tools have to work from a `driveMode: batch` chat, which does not.

## The gating matrix

Four independent instance flags, each also settable as a YAML key in
[`paddock.config.yaml`](/configuration/config-file/) (env wins over file).

| Tier | Tools | Requires |
| --- | --- | --- |
| **Read** | `list_projects`, `list_chats`, `read_chat` | `PADDOCK_SELF_MCP` / `selfMcpEnabled` |
| **Write** | `create_chat`, `fork_chat`, `send_message`, `archive_chat`, `unarchive_chat`, `fork_chat_batch` | `PADDOCK_SELF_MCP_WRITE` / `selfMcpWriteEnabled` **and** read |
| **Project** | `create_project`, `promote_project` | `PADDOCK_SELF_MCP_PROJECTS` / `selfMcpProjectsEnabled` **and** write **and** read |
| **Triggers** | `list_triggers`, `set_trigger`, `remove_trigger`, `run_trigger` | `PADDOCK_HOOKS_MCP` / `hooksMcpEnabled` (per-project override wins) **and** write |

All four default to **`false`**. The nesting is enforced in the config loader
itself, not just by convention: `selfMcpWriteEnabled` resolves to `false` unless
`selfMcpEnabled` is also on, and `selfMcpProjectsEnabled` resolves to `false`
unless both of the others are.

Three details that are easy to get wrong:

- **The project tools have their own flag on purpose.** Every other write tool
  acts *within* an existing project. These mutate **instance-level** state (a new
  directory in the projects root, new long-lived agents; or an existing project's
  working directory moved to a fresh checkout) and run `git clone` on a
  caller-supplied URL. It is an operator-intent boundary rather than a hard
  security one — Claude with `Bash` in a write-enabled project can already
  clone whatever it likes — but provisioning infrastructure should be opt-in.
  `promote_project` shares the flag rather than getting a third one: same
  blast-radius class, and an operator who granted "may provision projects" has
  already made that call.
- **The trigger gate is the *hooks* flag, reused.** There is no
  `PADDOCK_TRIGGERS_MCP`. Epic T collapsed the separate schedule and hook verbs
  into one trigger family and kept the existing `PADDOCK_HOOKS_MCP` gate, which a
  project's `hooksMcpEnabled` in `project.yaml` can override at dispatch.
- **The trigger gate is resolved from the project the chat lives in.** The
  trigger tools all take an optional `project` argument that can name a
  *different* project — the gate that decided whether they exist was resolved
  against the current one. Enable it per project only if you're comfortable with
  that reach; otherwise leave it on the instance default.

`scheduleMutationEnabled` / `PADDOCK_SCHEDULE_MUTATION` is **not** part of this
matrix. It only constructs herdctl's fleet manager with `allowScheduleMutation`;
Paddock arms a schedule trigger by re-registering the project's agent, and nothing
in the self-MCP tool-gating path reads that flag.

### `maxSpawnDepth` — whether a *spawned* child gets the server at all

The flags above govern a chat a human is driving. A chat that was **spawned** by
another agent (or started by a schedule/event trigger) carries a recorded
**depth**, and that depth decides whether it receives `paddock_manage`:

> A server-initiated turn at depth `d` gets the self-MCP iff `d ≤ maxSpawnDepth`.

| Setting | Env var | Default | Effect |
| --- | --- | --- | --- |
| `maxSpawnDepth` | `PADDOCK_MAX_SPAWN_DEPTH` | `1` | Depth-1 children get the tools (so a child can `send_message` back to its parent, and can spawn); depth-2 grandchildren do not. |

- `0` — no spawned child gets the server. A manager can fan work out, but the
  children are terminal: they cannot report back through `send_message`.
- `n` — the tree may grow `n` spawn-hops deep before the tools stop.
- Valid values are integers `0`–`8`; anything else falls back to the default.
- A **per-project** `maxSpawnDepth` in `project.yaml` (editable from the
  project's Settings tab) wins over the instance value at dispatch.

The comparison is `≤` because it is evaluated at the **child**, using the child's
own depth. "A depth-`d` child may act, `d ≤ maxSpawnDepth`" is the same bound as
"a depth-`(d-1)` parent may spawn, `(d-1) < maxSpawnDepth`".

A **human** turn is never depth-gated — it is the root of any spawn tree (depth
0), so it is governed by the instance flags alone. The write tier still applies
to a spawned child: an operator who left writes off gets read-only children.

## Result shape

Every tool returns a single text block containing **JSON** — this toolset is read
by the *agent*, so there is no render envelope (unlike
[`send_file`](#the-other-injected-server-send_file)).

A failure comes back as an MCP tool result with `isError: true` and a plain
human-readable message, on a successful call — the model needs to read it. So a
missing required argument, an unknown model id, an out-of-range value or a store
error all arrive as prose, not as a transport-level error.

Two payload caps apply throughout, and both are visible in the output rather than
silent:

| Cap | Value | Where |
| --- | --- | --- |
| Per-message text | **2 000 chars**, then `… [truncated N chars]` | `read_chat` messages, and the echoed `prompt` on write tools |
| Forks per call | **20** | `fork_chat_batch` |

## Read tools

Present whenever `PADDOCK_SELF_MCP` is on.

### The root workspace's key is `""`

Every `project` argument below is really a **workspace key** — a path relative to
the projects root. The **root workspace** (the instance's own top-level
directory, "Home" in the sidebar) is a workspace like any other, and its key is
the **empty string**. So `project: ""` addresses the root, and an *absent*
`project` is what means "unspecified".

That distinction is load-bearing, because `""` is falsy. Until #560 these tools
tested it for truthiness, which made every root chat unreachable — `list_chats
{"project": ""}` silently answered for *all projects*, and `read_chat` reported
`project` missing when it had been supplied.

### `list_projects`

Every project on the instance, across all areas. No arguments.

**Returns** `{ count, projects: [{ slug, name, area?, status }], root }`. `area`
is omitted when the project has none. Use `slug` to target the other tools.

`root` is the **root workspace** in the same `{ slug, name, area?, status }`
shape, with `slug: ""` — or `null` when the caller's scope doesn't reach it. It
is deliberately **not** a member of `projects`, and not counted in `count`: the
root is not a project, and enumeration walks the projects root's *children*
only. It rides alongside instead, exactly as `GET /api/projects` returns
`{ projects, root }`. This is how a caller learns the root exists at all.

### `list_chats`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no | Workspace key to filter by: a project slug, or `""` for the **root workspace**. **Omit to list chats across all workspaces** — every project *and* the root. |
| `include_archived` | boolean | no | Include archived chats. **Defaults to `false`**, matching the web UI. |

Cheap — it does not read transcripts.

**Returns** `{ count, omittedArchived, project, chats: [{ project, sessionId, name, updatedAt, running, archived }] }`,
where `project` echoes the filter (`null` when unfiltered — distinct from `""`,
which is the root), `updatedAt` is the last transcript write and `running` says
whether a turn is in flight. A root chat reports `project: ""`; pass that value
back to `read_chat` verbatim.

`name` falls back to an **8-character `sessionId` prefix** when the chat has no
stored title. Read that as *untitled* — it is not a meaningful name, and it is
not a usable id, so don't pass it anywhere a full `session_id` is wanted.

**Archived chats are hidden by default.** The web UI files them into a collapsed
"Archived" section, and this tool now agrees — on an instance with a few hundred
chats the archived ones would otherwise dominate the response. `omittedArchived`
reports how many were withheld, so the filter is never silent.

That matters more than it looks: `list_chats` is the **only** way anything
discovers a `session_id`. Hide an archived chat without saying so and it becomes
unaddressable — no `read_chat`, no `unarchive_chat`, and no clue why. Pass
`include_archived: true` whenever you need one back.

### `read_chat`

A trimmed **tail** of a chat's transcript.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | **yes** | Workspace that owns the chat: a project slug, or `""` for the root workspace. Use whatever `list_chats` reported, verbatim. Required means *present* — `""` is a valid value, an absent argument is the error. |
| `session_id` | string | **yes** | From `list_chats`. |
| `limit` | number | no | Trailing messages to return. Default **30**, max **200**; out-of-range values are clamped, not rejected. |

**Returns** `{ project, sessionId, total, returned, messages: [{ role, text, timestamp }] }`.
`total` is the full transcript length and `returned` the tail size, so the agent
can tell it is looking at a window. `role` is `user`, `assistant` or `tool`; each
`text` is capped at 2 000 characters.

:::caution[A lossy view — know what it drops]
`role: "tool"` entries always have **empty `text`**. The tool's name, input and
output are not included, and those blank entries still count against `limit`, so
on a tool-heavy chat most of the response is padding. Thinking blocks,
attachments and sub-agent transcripts are dropped entirely.

So `read_chat` answers *"what is this chat about, what was decided"*. It cannot
answer *"how did this chat go"* — errors, tool failures, stalls, cost. For that,
read the transcript directly: it is JSONL, one object per line, at
`<data-dir>/projects/<slug>/.chats/<sessionId>.jsonl`, with any sub-agents under
`<sessionId>/subagents/agent-*.jsonl`.

An unknown `session_id` returns `total: 0` with **no error**. That means *not
found*, not *empty chat* — re-check the id before concluding anything from it.
:::

## Write tools

Present when `PADDOCK_SELF_MCP_WRITE` is on **and** the read tier is on. These
start real turns through the same engine the web UI drives, so a spawned chat
appears in the sidebar, streams live, and is re-attachable.

Every write tool takes an optional **`project`** slug that defaults to the
project the calling chat lives in.

The three spawning tools take an optional **`model`** for the spawned chat's
kickoff turn only — it does not change the project default. It is validated
against the same allow-list the web model picker uses; an unrecognised id is
refused with an actionable error listing the valid ids rather than silently
ignored.

### `create_chat`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | string | **yes** | The full first turn for the new chat. |
| `project` | string | no | Defaults to the current project. |
| `name` | string | no | **Strongly recommended** — a concise 3–5 word title. Without it the title falls back to a long auto-summary of the first turn. |
| `preload_context` | boolean | no | Seed the new chat with the project's `OVERVIEW.md` + `CHANGELOG.md`. |
| `model` | string | no | Model for this chat only. |

**Returns** `{ created: true, project, sessionId, name, model, prompt }` — the
prompt is echoed (truncated) so the tool call renders with the real message.

The new chat appears **nested under the chat that called this tool**, so a
fan-out folds up as one family in the sidebar. Called over the external
[`/mcp`](/reference/mcp/) instead there is no calling chat to nest under, and the
new chat is a root.

### `fork_chat`

Fork an existing chat into a new child that inherits its history, then optionally
kick the child off.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `session_id` | string | no | Source chat. **Omit to fork the CURRENT chat** (the one the agent is in). |
| `project` | string | no | Defaults to the current project. |
| `prompt` | string | no | Optional kickoff turn. **A fork with no `prompt` runs no turn.** |
| `name` | string | no | Display name for the fork. |
| `model` | string | no | Applies to the kickoff turn only — so a `model` without a `prompt` has no effect. |

**Returns** `{ forked: true, project, sessionId, from, name, model, prompt }`.

A fork nests under its **source** — the chat named by `session_id` — not under
the chat that called the tool. Forking someone else's chat therefore files the
result beside that chat's own children, not beside yours.

Fails with `no chat to fork (current chat id not yet known — pass session_id)`
if it defaults to the current chat before that chat's id has resolved.

### `send_message`

Send a new turn to a chat that already exists — the way a child reports back to
its parent.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `session_id` | string | **yes** | Target chat, from `list_chats`. |
| `prompt` | string | **yes** | The message to send as a new turn. |
| `project` | string | no | Defaults to the current project. |

**Returns** `{ sent: true, project, sessionId, prompt }`.

### `archive_chat` / `unarchive_chat`

File a chat into (or out of) the collapsible **Archived** section. Presentational
metadata only — the transcript is untouched and the chat stays openable,
resumable and forkable.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `session_id` | string | no | **Omit to archive/unarchive the CURRENT chat — i.e. yourself.** |
| `project` | string | no | Defaults to the current project. |

**Returns** `{ archived, project, sessionId }`, where `archived` is `true` for
`archive_chat` and `false` for `unarchive_chat`.

`archive_chat` powers the **self-reporting convention**: an agent does its work
and then archives itself on success, so an un-archived chat is the signal that
something wants a human's attention. Archiving is also the lifecycle event an
`onArchive` [trigger](/reference/hooks/) fires on.

### `fork_chat_batch`

The fan-out primitive: fork **one** source chat into many children at once, one
per directive, each kicked off with its own prompt. The classic use is "I found N
items, give me one worker per item".

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompts` | string | **yes** | The fork directives, **one per line** (1–20 lines). A JSON array of strings is also accepted. |
| `session_id` | string | no | Shared source. Omit to fork the **current** chat. |
| `project` | string | no | Defaults to the current project. |
| `name_prefix` | string | no | Each fork is named `"<name_prefix> <i>"`, 1-based. |
| `model` | string | no | Applies to **every** fork's kickoff turn. |

**Returns** `{ count, source, model, forks: [{ sessionId, prompt }] }`. The forks
are created concurrently; herdctl enforces the real concurrency cap downstream.

More than 20 directives, or any blank entry, is refused with an explicit error
rather than partially executed.

## Project tools

Present only when `PADDOCK_SELF_MCP_PROJECTS` is on, on top of write and read.

### `create_project`

Provision a whole new project — its directory, `project.yaml`, seeded notes files
and, when a `repo` is given, a cloned nested checkout — and register its agent.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | **yes** | Display name. |
| `slug` | string | no | Kebab-case (lowercase `a-z`, `0-9`, single hyphens). Omit to derive it from `name`. |
| `repo` | string | no | A git URL (`https://`, `git://`, `ssh://`, or `git@host:owner/repo`). Supplying it makes the project **unmanaged** and clones the repo into a nested checkout that becomes the agent's working directory. Omit for a **managed** notes project. |
| `summary` | string | no | One-line description. |
| `area` | string | no | The grouping shown in the sidebar. |
| `status` | enum | no | One of `idea`, `active`, `paused`, `blocked`, `done`, `abandoned`. Default `active`. |

**Returns**
`{ created: true, slug, name, dir, workingDir, managed, repo?, path?, keeperRegistered }`.
`dir` is the project's metadata directory; `workingDir` is the agent's cwd (the
nested checkout when a `repo` was cloned, otherwise `dir`). `managed` says whether
Paddock curates the project's own files — it replaced the older `repoBacked` flag,
which conflated that question with whether a git repo was involved (see
[Projects](/concepts/projects/#two-axes-not-three-types)).

This tool does not expose `path`; an agent cannot point a new project at an
arbitrary directory on the box. Create those from the UI or the REST API.

Two things this tool guarantees, and one it doesn't:

- **It is the same code path as `POST /api/projects`** — the same store `create`
  followed by the same agent registration, in the same order, so the REST and
  MCP paths cannot drift. All validation, the clone, and its rollback live in the
  store.
- **A bad or unreachable repo URL leaves nothing behind.** The whole project
  directory is rolled back on a clone failure, so it is safe to retry with a
  corrected URL. Server filesystem paths are stripped from the error before the
  agent sees it (a `git clone` failure otherwise surfaces the entire argv).
- **`keeperRegistered: false` is not a failure.** Mirroring the REST route, the
  project *is* created even if agent registration fails — but it is reported,
  because a project with no live agent cannot accept a `create_chat` yet.

### `promote_project`

Turn an **existing managed (notebook) project into an unmanaged, repo-backed one,
in place** — for when a notes-only project has grown into (or was always meant to
be) a codebase, and you would otherwise create a second project and abandon the
first.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no | Slug of the notebook project to promote. Defaults to the **current** project. |
| `repo` | string | **yes** | A git URL (`https://`, `git://`, `ssh://`, or `git@host:owner/repo`). |

**Returns**
`{ promoted: true, slug, name, dir, workingDir, managed, repo, agentRegistered }`
— the same report `create_project` returns, because a promoted project ends up in
exactly the state a `repo:`-carrying `create_project` would have produced.
`managed` is always `false` on a successful promote: crossing that axis is what
promoting now means (#206 replaced the older `repoBacked` flag).

- **It is the same code path as `POST /api/projects/:slug/promote`** — the same
  store `promote` followed by the same agent re-registration, in the same order.
- **Existing chats are kept.** The project's transcripts already live in its
  `.chats/` store; re-registering the agent re-symlinks the *new* working
  directory at that same store, so every chat stays listed and resumable.
- **Only ever managed → unmanaged.** A project that is already unmanaged is
  refused, as is the root workspace. There is no MCP verb to undo a promotion.
- **A bad or unreachable repo URL leaves the notebook untouched.** The clone runs
  before anything is mutated, and a failure rolls back just the checkout, so it is
  safe to retry with a corrected URL. Server filesystem paths are stripped from
  the error before the agent sees it.

## Trigger tools

Present when `PADDOCK_HOOKS_MCP` (or the project's `hooksMcpEnabled` override) is
on **and** the write tier is on. These are the unified Epic T verbs — they
replaced the separate `set_schedule` / `set_hook` families, and manage all
trigger types (`schedule`, `event`, and the reserved `webhook`) through one
surface.

All four take an optional **`project`** slug defaulting to the current project.

### `list_triggers`

| Argument | Type | Required |
| --- | --- | --- |
| `project` | string | no |

**Returns** `{ project, count, triggers: [...] }`. Each trigger is a **flat**
record regardless of type: `name`, `agentName`, `type`, the when-fields
(`cron`, `interval`, `event`, `path` — `null` when not applicable), the run
(`prompt`, `promptFile`, `session`, `tools`, `model`, `permissionMode`,
`maxSpawnDepth`, `maxTurns`) and `enabled`. For an **armed schedule** trigger,
best-effort live state is merged in: `status`, `lastRunAt`, `nextRunAt`,
`lastError`. Read-only.

### `set_trigger`

Create **or** update a trigger, keyed by `name`. There is no separate
enable/disable verb — that is this call with `enabled` flipped. A brand-new
trigger defaults to `enabled: false`.

| Argument | Type | Notes |
| --- | --- | --- |
| `name` | string | **Required.** The trigger's stable key. |
| `type` | `schedule` \| `event` \| `webhook` | The *when*. Omit on an edit to keep the existing one; supplying it re-specifies the trigger. |
| `cron` | string | Schedule: a 5-field expression, host-local. **Exactly one** of `cron`/`interval`. |
| `interval` | string | Schedule: a duration such as `30m` or `1h`. |
| `event` | string | Event: the lifecycle event (v1: `onArchive`). |
| `path` | string | Webhook: the ingress path. Reserved — nothing fires it yet. |
| `prompt` | string | Inline instruction. Provide this **or** `prompt_file`. |
| `prompt_file` | string | A `.md` file under the project's `.paddock/triggers/`, read at fire time. |
| `session` | `new` \| `resume` | `new` (default) = a fresh chat each fire; `resume` = accrete into the trigger's one owned session. |
| `tools` | string | The fired agent's deny-by-default allow-list — one per line or comma-separated. Omitted/empty = a tool-less curator. A JSON array is also accepted. |
| `model` | string | Model override for the fired agent. |
| `permission_mode` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` | Permission mode the fired turns run under. |
| `max_spawn_depth` | number | Recursion bound for the fired agent's own spawning (`0` = may not spawn). |
| `max_turns` | number | Turn bound on a runaway trigger. |
| `enabled` | boolean | Defaults **false** on a new trigger; omitted on an existing one leaves it unchanged. |

Edits are a **patch**: a field you omit is preserved, so an `enabled`-only call
just flips the toggle. Supplying `prompt` clears an inherited `prompt_file` and
vice versa. A `type` you supply without its required when-field (a `schedule`
with neither `cron` nor `interval`, an `event` with no `event`) is refused with a
specific message.

**Returns** `{ set: true, project, trigger }` — the saved trigger in the same
flat shape `list_triggers` returns.

The full `project.yaml` schema behind these fields lives in the
[Hooks reference](/reference/hooks/) and the
[Schedules reference](/reference/schedules/).

### `remove_trigger`

| Argument | Type | Required |
| --- | --- | --- |
| `name` | string | **yes** |
| `project` | string | no |

Deletes it from `project.yaml` and disarms its agent/schedule. Safe when absent.

**Returns** `{ removed, project, name }` — `removed` is `false` when no such
trigger existed, which is a success, not an error.

### `run_trigger`

Fire a trigger **now**, on demand — through the same path a cron or event fire
uses, so the resulting chat is a first-class, badged run rather than an ad-hoc
chat.

| Argument | Type | Required |
| --- | --- | --- |
| `name` | string | **yes** |
| `project` | string | no |

Works for **any** trigger type and **regardless of its `enabled` flag** — a
manual run is a deliberate act. This is how an agent tests a trigger it just
wrote, or kicks one off out of band.

**Returns** `{ ran: true, project, name, sessionId }` — the started chat's id.

Two refusals to expect: an unknown trigger (or one that started no chat) comes
back as *"no such trigger, or it did not start a chat"*, and the post-turn
**curator** trigger is refused explicitly, because it runs automatically after
every turn on the sweeper's agent and has no on-demand path.

## The other injected server: `send_file`

`paddock_manage` is not the only server Paddock injects. A separate one under the
server key **`paddock`** provides **`mcp__paddock__send_file`**, which renders a
file inline in the chat. It is injected on **every** turn — human *and* spawned —
and is not affected by any flag on this page.

It is documented in
**[Sending files & images](/using/sending-files-and-images/)**; nothing about it
is restated here.

:::caution[`paddock` and `paddock_manage` are reserved names]
Both are materialised under the `mcp__<name>__*` tool namespace, and two servers
claiming one namespace has no defined winner. So a server you
[declare yourself](/configuration/config-file/#mcpservers--the-servers-this-instance-declares-itself)
under either name is **refused outright** — an error naming the clash, with that
server not attached, rather than a silent shadowing. The rest of the block still
loads and the instance still starts. Pick any other key.
:::

## The in-process surface vs. the external `/mcp` API

Paddock exposes the *same underlying operations* two ways, and it is worth being
precise about how they differ, because the intuition runs backwards.

| | **In-process** (`paddock_manage`) | **External** ([`/mcp`](/reference/mcp/)) |
| --- | --- | --- |
| Who calls it | Claude inside this instance | A caller outside it — a laptop Claude Code session, CI, a peer Paddock |
| Transport | Injected server over a localhost bridge | Authenticated streamable-HTTP JSON-RPC |
| Authentication | **None** — it runs full-trust inside the instance | A bearer token per configured client |
| What bounds it | The instance flags on this page, plus `maxSpawnDepth` | The credential's **scope** (`projects` / `allow` / `deny`) |
| Default posture | Everything off | Read-only |

Both go through the **same operations layer**, which is where policy is enforced —
so a new transport inherits identical checks and cannot forget them, and a tool
added here appears over `/mcp` for free.

:::danger[The flags on this page do NOT gate `/mcp`]
This is the natural assumption and it is **wrong**. The `/mcp` route builds its
operations with the write, trigger and project capabilities **all opened
unconditionally**, and then narrows the result by the calling client's scope.
`PADDOCK_SELF_MCP`, `PADDOCK_SELF_MCP_WRITE`, `PADDOCK_SELF_MCP_PROJECTS` and
`PADDOCK_HOOKS_MCP` bound what **Claude** may reach in-process — they are not a
kill-switch for the external surface.

That is the right split (an external client should be bounded by its credential,
not by a per-project gate), but it means **leaving these flags off does not make
a configured `/mcp` client read-only.** What makes it read-only is
giving it no write `allow` — which is the default. If you want the external
surface off entirely, remove its `clients` (then `/mcp` `404`s).
:::

## See also

- **[Management API (MCP)](/reference/mcp/)** — the external `/mcp` endpoint: its
  authenticator, scopes, discovery document and response matrix.
- **[Config file (YAML)](/configuration/config-file/)** — the YAML keys for every
  flag above, and how they layer with the environment.
- **[Environment variables](/configuration/environment/)** — the `PADDOCK_*`
  forms.
- **[Hooks reference](/reference/hooks/)** and
  **[Schedules reference](/reference/schedules/)** — the `project.yaml` trigger
  schema the trigger tools write.
- **[Architecture overview](/architecture/overview/)** — where MCP injection sits
  in the turn pipeline.
