---
title: "Workspaces"
description: "The workspace is Paddock's unit of work. The instance itself is one; a project is a workspace nested inside it."
---

A **workspace** is a directory with a [keeper agent](/concepts/keepers) attached, plus
everything that hangs off that pairing: chats, files, changes, history, settings, and
triggers. It is the unit Paddock actually operates on.

The instance itself **is** a workspace — the projects root, with its own keeper. A
[**project**](/concepts/projects) is a workspace nested inside it. So "project" is not the
general case any more; it is the special case with a non-empty name.

```
<projectsRoot>/          ← the ROOT workspace (keeper cwd = this directory)
├── paddock/             ← a project = a workspace nested inside the root
├── herdctl/             ← another
└── notes.md             ← the root's own files
```

Everything a project can do, the root can do, and by the same code — see
[one plugin, two mounts](#one-plugin-two-mounts) below for why that is a structural
guarantee rather than a promise.

## Identity: a workspace is its path

A workspace is identified by a **workspace key** — its path *relative to the projects
root*. A project's key is its slug (`paddock`). Nested workspaces are just longer
relative paths (`repo/sub`); nothing in the model assumes a single segment.

That makes the root's key **the empty string**, and this is the load-bearing design
choice of the whole model. The empty string is not a reserved name or a sentinel — it is
the zero value already sitting in the key space, the correct relative path from the
projects root to itself. Because `path.join(root, "") === root`, resolution needs no
special case at all:

```ts
function dirFor(root: string, key: string): string {
  return path.join(root, key);   // the root falls out; there is no branch
}
```

An earlier design modelled the root as a project holding a reserved slug (`__root`),
which forced every resolver to branch on it. That branch got duplicated, one copy was
missed, and every root file route 404'd. With a relative-path key there is no branch to
forget — the bug class is *unrepresentable*, not merely fixed.

## One plugin, two mounts

An empty string cannot ride in a URL path segment: `/api/projects//chats` does not match
any route. Rather than smuggle a sentinel back onto the wire, Paddock registers the
workspace-scoped routes as **one Fastify plugin, mounted twice**:

| Mount                 | Workspace key  |
| --------------------- | -------------- |
| `/api/root`           | `""`           |
| `/api/projects/:slug` | `params.slug`  |

Handlers were left untouched by the split — they still read `req.params.slug`. The root
mount has no `:slug` segment to match, so it adds an `onRequest` hook that injects
`slug: ""`. `onRequest` is the earliest lifecycle hook and, in particular, runs *before*
params validation, so the existing `required: ["slug"]` schemas keep validating unchanged
on a path that has no such segment.

The result is the point: `/api/root/chats` and `/api/projects/paddock/chats` are the same
handler, the same schema, and the same error paths. **Parity between the root and a
project is true by construction, not by discipline** — a route that exists on only one of
the two mounts is a bug in the mount, not a missing feature.

## The root always exists

There is nothing to create and nothing to enable. The root workspace has no `project.yaml`
gate, no creation endpoint, and no "enable" card — a fresh instance serves `GET /api/root`
with a 200 on the first boot. Its metadata is **derived** (the name defaults to the
projects-root directory's basename), and a record is written to disk **lazily**, only once
you change a setting.

Its keeper and sweeper are registered at boot like any workspace's, and its transcripts
are gitignored like any workspace's.

## The one surviving sentinel

herdctl agent names must be non-empty, so the empty key genuinely cannot be represented in
that namespace. It is encoded there — and only there — as `_root`:

| Workspace     | Keeper agent    | Sweeper agent    |
| ------------- | --------------- | ---------------- |
| the root      | `keeper-_root`  | `sweeper-_root`  |
| `paddock`     | `keeper-paddock`| `sweeper-paddock`|

That is **one** leading underscore. The same encoding applies to `hook-_root-<name>` and
`trigger-_root-<name>`. It can never collide with a project, because project slugs are
lowercase alphanumerics and dashes — the slug pattern rejects underscores outright, so no
slug can ever equal `_root`.

This is a *name*, not an identity. A workspace is identified by its key everywhere else;
the encoding is applied in a single function at the herdctl boundary, which keeps all four
agent-name builders uniform with no root branch of their own.

:::note[For contributors: the empty key is a live hazard]
Because the root's key is `""`, **`if (!slug)` is a bug wherever a workspace key is
tested** — it silently drops the root while looking perfectly reasonable. Three such bugs
shipped and were fixed after the model landed (parent-edge provenance, the recovery nudge,
and the unread badge), all of which read as "works for projects, mysteriously skips the
root".

Test the key explicitly instead:

```ts
if (slug !== undefined) { … }   // ✅ present, possibly the root
if (!slug) { … }                // ❌ also matches the root
```
:::

## Scope: what the root keeper can reach

A project keeper's working directory is its own project directory, so its file surface,
its Changes pane, and its Bash calls are confined to that subtree.

**The root keeper's working directory contains every project.** It can read and edit any
project's files, and its Changes tab is the *whole* backing repo — which is exactly the
intent: the root is where you commit across the instance and do cross-project work. But it
is a real step up in reach from a project keeper, and worth knowing before you hand a root
chat a broad instruction.

The file surface applies its usual guard at the root: paths are resolved and refused if
they escape the workspace directory, or if they traverse *through* any dot-prefixed
directory segment. So `.chats/` and `.git/` stay unreachable through the files API at the
root just as they are inside a project.

## The root in the UI

`/` **is** the root workspace's Home — the instance's front door, no redirect and no
sticky last tab. The root carries the full workspace tab bar, with each tab at a top-level
URL:

| Tab      | Root URL    | Project URL                |
| -------- | ----------- | -------------------------- |
| Home     | `/`         | `/projects/:slug/home`     |
| Chat     | `/chat`     | `/projects/:slug/chat`     |
| Files    | `/files`    | `/projects/:slug/files`    |
| Changes  | `/changes`  | `/projects/:slug/changes`  |
| History  | `/history`  | `/projects/:slug/history`  |
| Settings | `/settings` | `/projects/:slug/settings` |
| Triggers | `/triggers` | `/projects/:slug/triggers` |

Changes appears only when the workspace directory is a git repo. There is **no** Projects
tab: the projects grid is a *section* of root Home, and `/projects` is kept as a permanent
redirect to `/` so links from an earlier release don't land on an error screen.

Two things stay instance-wide rather than workspace-scoped. `/settings` at the root edits
the root workspace's own `project.yaml`, exactly like a project's Settings tab does;
instance-wide admin config lives separately at `/config`, because its lifecycle is
different — it is frozen at boot, so every save is restart-required. See
[Environment variables](/configuration/environment) for what that file holds.

## Where to go next

- [**Projects**](/concepts/projects) — the nested case: notebook vs. repo-backed, and what
  a project directory contains.
- [**Keeper agents**](/concepts/keepers) — the agent attached to each workspace.
- [**Chats are sessions**](/concepts/chats) — what lives inside a workspace's Chat tab.
- [**API reference**](/reference/api) — the workspace-scoped routes, at both mounts.
