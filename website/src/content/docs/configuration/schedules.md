---
title: "Scheduling & the schedule gates"
description: The per-deployment gates that govern programmatic schedule mutation (the REST API) and keeper self-scheduling (the MCP tools) — both off by default, while statically-declared schedules always arm.
---

Schedules are powerful precisely because they run unattended, so a deployment gets
to decide **who may change them at runtime**. Two independent, off-by-default gates
govern that; neither one stops a schedule you've *declared* in `project.yaml` from
firing.

## The one thing that's never gated

A schedule written into a project's `project.yaml` is **always armed** — it's the
source of truth, re-armed from the file on every restart. The gates below only
govern *mutating* schedules **programmatically at runtime** (via the older REST
API or the self-MCP tools). If you hand-edit `project.yaml`, or use the per-project
**Triggers tab**, no gate stands in your way:

![The Triggers tab, where schedules are declared and managed per project](../../../assets/schedules/triggers-tab-schedules.png)

## The schedule-mutation gate (REST API)

The legacy per-project schedule REST API — `PUT` / `DELETE` on
`/api/projects/:slug/schedules/:name`, and the enable/disable actions — is gated by
a single per-deployment flag, **off by default**:

| Setting | Env var | Default | What it does |
| --- | --- | --- | --- |
| `scheduleMutationEnabled` | `PADDOCK_SCHEDULE_MUTATION` | `false` (OFF) | Allow the schedule REST API to **create, update, enable/disable, and delete** schedules at runtime. |

The variable accepts `1` / `true` / `yes` (case-insensitive) for on. With it off,
those mutating routes return a `403` with code `schedule_mutation_disabled`; reads
(`GET`) are always allowed. In a YAML instance-config file it's the same key:

```yaml
# instance config
scheduleMutationEnabled: true
```

```bash
# or via the environment
PADDOCK_SCHEDULE_MUTATION=1
```

:::note[This gate is about *runtime* mutation, not firing]
Turning the gate off doesn't disable scheduling — it only means schedules can't be
mutated through that REST surface. Statically-declared schedules keep firing, and
the per-project Triggers tab keeps working, regardless.
:::

## Self-scheduling from a chat

For a keeper to **schedule itself** from a conversation (the
[manager-agent pattern](/using/scheduling-recurring-work/#schedule-from-a-chat-the-manager-agent-pattern)),
it needs the schedule-management MCP tools — `set_trigger`, `list_triggers`,
`remove_trigger`. Those are injected only when the trigger-management MCP is
enabled, again **off by default**:

| Setting | Env var | Default | What it does |
| --- | --- | --- | --- |
| `hooksMcpEnabled` | `PADDOCK_HOOKS_MCP` | `false` (OFF) | Inject the `set_trigger` / `list_triggers` / `remove_trigger` self-MCP tools into the project's keeper, letting it manage its own triggers (schedules and event hooks alike). |

It accepts `1` / `true` / `yes`, and a per-project `hooksMcpEnabled` override in
`project.yaml` wins over the instance default. When it's off, the tools are simply
**absent** from the keeper — not present-but-refusing — so a keeper on a plain
deployment can't self-schedule at all.

```bash
# instance-wide
PADDOCK_HOOKS_MCP=1
```

```yaml
# project.yaml — opt one project in
hooksMcpEnabled: true
```

:::caution[Grant self-scheduling deliberately]
A keeper with these tools can create schedules that fire unattended and grant
their own tool capabilities. Enable it for projects you trust to manage their own
routine, and lean on per-trigger tool allow-lists (see the
[reference](/reference/schedules/#the-trigger-schema-schedule)) to keep each fired
job's capability tight.
:::

## Where these fit

Both gates follow Paddock's usual precedence — **built-in default → YAML instance
file → environment variable**, with a per-project override on top where one exists
(`hooksMcpEnabled`). See [Environment variables](/configuration/environment/) for
the full list of instance settings.

## Next steps

- [Schedules](/concepts/schedules/) — the concept behind cron/interval schedules.
- [Scheduling recurring work](/using/scheduling-recurring-work/) — creating and
  managing schedules in the UI and from a chat.
- [Schedules reference](/reference/schedules/) — the trigger schema, the self-MCP
  tools, and the REST endpoints these gates govern.
