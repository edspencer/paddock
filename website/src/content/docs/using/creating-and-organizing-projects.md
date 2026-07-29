---
title: Creating & organizing projects
description: A hands-on walkthrough — make a new project (notebook or repo-backed), promote a notebook to repo-backed in place, fill in its project.yaml, group projects into areas, tune the agent in Settings (models, curation budgets), and promote a root chat into a project.
---

Everything you do in Paddock lives inside a **project**. This guide is the
practical, do-it-now companion to the [Projects concept](/concepts/projects/):
that page explains *what* a project is; this one walks through *how* to create
one, organize a growing collection, and tune it to your taste.

By the end you'll know how to create both kinds of project, sort them into
**areas**, set per-project metadata and agent behaviour, and rescue a root chat
by promoting it into a project of its own.

## Create a new project

Click **New Project** — the button is in the left sidebar, and again on the
projects home page (top-right, and in the empty state when you have none yet).
That opens the **New project** dialog:

![The New project dialog with a Git repository URL filled in, making it a repo-backed project](../../../assets/using/new-project-modal.png)

You only have to fill in **one** field — everything else has a sensible default:

- **Name** *(required)* — a human title, e.g. `Garden Planner`. Paddock derives
  the on-disk **slug** from it automatically (`Garden Planner` → `garden-planner`),
  so you never type a slug.
- **Summary** *(optional)* — one line on what the project is about.
- **Area** — the single group this project belongs to (see
  [Organize projects into areas](#organize-projects-into-areas)). Defaults to
  **Unsorted**; you can move it later.
- **Git repository URL** *(optional)* — leave it blank for a **notebook**
  project; paste a repo URL to make it **repo-backed** (next section).
- **Domain tags** — comma-separated, cross-cutting labels like
  `garden, planning`. Unlike the area, a project can carry many tags.
- **Status** — defaults to **active**. Pick `idea` for something you're still
  mulling.

Click **Create project** and you're dropped straight into the project's first
chat, ready to start working.

:::note[No slug or visibility field here]
The dialog keeps creation to the essentials. The **slug** is generated from the
name, and **visibility** defaults to `public`. Both — plus everything above —
are editable afterwards from the project's [Settings tab](#tune-the-agent-the-settings-tab).
:::

## Choose the project type: notebook vs repo-backed

The single choice that matters at creation time is whether you fill in the
**Git repository URL** field. It's what splits the two project types. You don't
have to get it right first time: a notebook can be
[promoted to repo-backed later](#promote-a-notebook-to-repo-backed), in place.
That promotion is **one-way**, though — a repo-backed project can never go back
to being a notebook.

### Notebook — for notes, plans, and ops

Leave the git field blank. The project directory itself becomes the working
directory, and Paddock seeds it with a starter `CLAUDE.md`. This is the right
choice for research, planning, home-lab runbooks, or anything that isn't itself a
code repository. Claude works with Markdown notes, docs, and the chat history —
all curated inside Paddock.

### Repo-backed — for a codebase you want Claude to build

Paste an external git URL and Paddock **clones that repo into a checkout inside
the project**, then points the working directory at the clone. HTTPS, SSH
(`git@host:owner/repo`), `git://`, and local paths all work.

Because Claude now works inside a real checkout, **the repo's own `CLAUDE.md`,
branches, and PR workflow all apply** — it can branch, commit, and open pull
requests against the upstream just like you would. Paddock keeps its own
metadata (`project.yaml`, `OVERVIEW.md`, `CHANGELOG.md`, and the chat transcripts)
in the enclosing project directory, safely outside the checkout via a sidecar
`.gitignore`.

:::caution[Private repos need reachable credentials]
Paddock runs `git clone` with credential prompts disabled, so a **private** repo
URL fails fast rather than hanging. Make sure the host can reach the repo (a token
in the environment, an SSH key, or a public URL) before creating a repo-backed
project. See [Securing Paddock](/guides/securing/) for how credentials reach the
box.
:::

For the full mechanics of `dir` vs `workingDir` and why metadata stays outside
the checkout, see the [Projects concept page](/concepts/projects/).

### Promote a notebook to repo-backed

A notes-only project that turns out to want a codebase doesn't have to be torn
down and recreated. From its **Settings** tab, the **Repository backing** section
turns a notebook into a repo-backed project **in place** — keeping every chat,
`OVERVIEW.md`, `CHANGELOG.md`, and every bit of metadata it has accumulated.

Paste the git URL, click **Promote to repo-backed…**, and confirm:

![The Repository backing section of a notebook project's Settings tab, with a git URL entered and the confirm step showing what promotion will do](../../../assets/using/promote-to-repo-backed.png)

Paddock **clones first**, so a clone that fails leaves the notebook completely
untouched. Once the clone lands, `repo:` is written to `project.yaml` and the
working directory **flips to the checkout** — from then on the repo's own
`CLAUDE.md`, branches, and PR workflow apply, exactly as for a project created
repo-backed.

Two consequences worth knowing before you click:

- **The notebook's `CLAUDE.md` is removed.** It was Paddock's to curate; the
  repo's own now takes over. (The sweeper keeps curating `OVERVIEW.md` and
  `CHANGELOG.md`, which live outside the checkout — it just never writes
  `CLAUDE.md` for a repo-backed project.)
- **It's one-way.** There is no un-promote, and no way to point an existing
  repo-backed project at a different repo. A repo-backed project's Settings tab
  shows its repository and working directory read-only.

If a directory named after the repo already exists inside the project, Paddock
refuses rather than overwriting it.

:::note[Two different "promotes"]
Don't confuse this with
[promoting a *root chat* into a project](#promote-a-root-chat-into-a-project)
further down. This one changes a project's **type**; that one turns a loose
conversation into a project in the first place.
:::

## What a project.yaml holds

A project is just **a directory plus a `project.yaml`** under your data root. You
rarely edit it by hand — the [Settings tab](#tune-the-agent-the-settings-tab)
writes it for you — but knowing the shape helps. A fuller example:

```yaml
# Paddock project metadata. Directory name MUST equal `slug`.
# status: idea | active | paused | blocked | done | abandoned
name: Garden Planner
slug: garden-planner
status: active
domain:
  - garden
  - planning
visibility: public
started: 2026-07-17
updated: 2026-07-17
summary: Beds, crop rotation, and a watering schedule for the back garden.
group: house
```

The fields:

| Field | What it is |
| --- | --- |
| `name`, `slug` | Title and its derived directory name. `slug` is **immutable**. |
| `status` | `idea` · `active` · `paused` · `blocked` · `done` · `abandoned`. |
| `visibility` | `public` or `private`. |
| `summary` | The one-liner shown on the card. |
| `domain` | Cross-cutting tags (many per project). |
| `group` | The project's **area** — its single, exclusive home. |
| `started`, `updated` | Creation date (immutable) and last-touched date (auto-bumped). |
| `links` | Optional `{label, url}` bookmarks. |
| `repo` | Present only for repo-backed projects. Absent on a notebook, and set **once** — at creation, or by [promoting](#promote-a-notebook-to-repo-backed). Once set it never changes. |
| `model`, `permissionMode`, `driveMode`, `maxTurns`, `docker` | Per-project agent overrides — see below. Absent means *inherit the box default*. |
| `models` | Optional allow-list narrowing which models this project offers — see [Restrict the offered models](#restrict-the-offered-models). |
| `curation` | Optional per-file sweeper token budgets — see [Curation budgets](#curation-budgets). |
| `maxSpawnDepth` | How deep this project may spawn tool-carrying children. |
| `pinned` | The files pinned as tabs in the project header. Paddock maintains this for you. |

Paddock writes only the fields it needs: on a freshly created project, agent
overrides you didn't set are absent from the file and resolve to the box-wide
defaults at run time. (Saving the [Settings tab](#tune-the-agent-the-settings-tab)
changes this for some of them — see the caveat there.)

## Organize projects into areas

As your collection grows, the projects home page keeps it legible by clustering
cards under their **area** — the project's `group`. An area is simply a
**free-form label**: the server stores whatever string you give it, so you can
have as many areas as you like and name them anything. The **Area** dropdown (in
the New Project dialog and in Settings) offers three ready-made ones —
**Homelab**, **House**, and **Side Projects** — plus **Unsorted**. Those four are
what the *UI* offers; to use an area of your own naming, set `group:` in
`project.yaml` (or via the API) and Settings will keep offering it thereafter.

![The projects grid grouped into Homelab, House, and Side Projects areas](../../../assets/using/projects-grid-areas.png)

On the home page an area only becomes a section **once at least one project uses
it** — a fresh Paddock with no projects shows no area sections at all. When
sections do appear they're ordered predictably: the three built-in areas first
(in the order above), then any custom areas alphabetically, then **Unsorted**
last. Each section is collapsible, with a heading and a project count. Set a
project's area at creation from the **Area** dropdown, or change it any time from
Settings.

:::tip[Areas vs. tags — one home, many labels]
A project lives in **exactly one area** (its shelf), but can carry **many domain
tags** (its cross-cutting labels). Tags are clickable — following one filters the
grid to every project that shares it — so use the area for *where a project
lives* and tags for *themes that cut across areas* (e.g. `networking`,
`urgent`).
:::

## Tune the agent: the Settings tab

Open any project and go to its **Settings** tab (`/projects/<slug>/settings`) to
edit everything the creation dialog left out, plus how Claude runs in that
project. Changes are staged and applied with **Save changes**.

**Identity & metadata** — Name, Summary, Status, Area, Visibility, Domain tags,
and Links, all editable here. (Slug, Started, and Created are shown read-only.)

**Claude** — the knobs that shape how the agent runs:

- **Model** — which Claude model the project uses. Larger context windows
  (Opus/Fable/Sonnet: 1M; Haiku: 200K) fit longer chats.
- **Permission mode** — how much Claude asks before acting:
  - **Default (ask each time)**
  - **Accept edits** *(the default)* — applies file edits without asking
  - **Plan only**
  - **Bypass all (use with care)** — runs every tool unprompted; only for
    sandboxes you trust.
- **Drive mode** — **Batch (one-shot per turn)** is the classic path; **Session
  (cross-turn autonomy)** keeps the agent alive across turns so features like
  `ScheduleWakeup` and `/loop` work. Leave it on **Global default** to inherit the
  box-wide `PADDOCK_DRIVE_MODE`; a **Reset to global default** button clears
  an override.
- **Max turns** — an upper bound (1–1000) on agent turns in a single run.
- **Docker sandbox** — run Claude inside a Docker container (needs a working
  Docker daemon on the box).
- **Max spawn depth** — how deep this project's spawned children may themselves
  carry Paddock's tools. Leave it on **Instance default** to inherit.

:::note[What "inherit" really means once you Save]
**Model, permission mode, max turns and docker** are written with **concrete
values** the first time you **Save** on this tab — so saving *freezes* them at
their current values rather than leaving them to track the box default
afterwards.

The genuine inherit/override controls, which stay *absent* from `project.yaml`
until you actually set them (and so keep tracking the instance default as it
changes), are **Drive mode** (left on **Global default**), **Max spawn depth**,
**Offered models**, and the three **Curation budgets**.
:::

Below that block the tab carries three more sections:
**[Offered models](#restrict-the-offered-models)**,
**[Curation budgets](#curation-budgets)**, and — for a notebook —
**[Repository backing](#promote-a-notebook-to-repo-backed)**. A final **Derived**
section shows read-only state the agent and sweeps maintain.

See [Environment variables](/configuration/environment/) for the defaults a fresh
project starts from.

### Restrict the offered models

By default a project offers whatever models the **instance** offers. The
**Offered models** field — a checkbox per instance model — narrows that for this
project: the project's own default model and the per-chat model picker are then
constrained to the subset you tick.

![A project's Settings tab restricting the offered models to three of the five the instance allows](../../../assets/whats-new/model-allow-list.png)

A project may only ever **subset** the instance list, never widen it; ticking
every box is the same as inheriting, and an **Offer all instance models** link
clears the override outright. (The instance's own list is set with
`PADDOCK_MODELS` or a `models:` list in `paddock.config.yaml`.) Because each
model's context limit and pricing come from Paddock's built-in catalog, an
allow-list only picks *which* models are offered — it can't misconfigure one.

### Curation budgets

The post-turn [sweeper](/concepts/sweeper/) keeps each of a project's three
curated files under a **token budget**. The **Curation budgets** section overrides
those per file for this project; leave a field blank to inherit the instance
default, which the placeholder shows you:

![Per-project curation budgets in the Settings tab, overriding two files and inheriting the third](../../../assets/whats-new/curation-budgets.png)

Inheritance is **field by field** — override `CHANGELOG.md` alone and the other
two keep tracking the instance defaults. Lowering a budget is the lever for a
chatty project whose notes have grown big enough to weigh on every chat that
preloads them. (A repo-backed project never has its `CLAUDE.md` curated, so that
budget is moot for it.)

### Preload project context (in the composer, not Settings)

One agent-related toggle lives on the **chat composer**, not the Settings tab:
**Preload project context**. On the **first turn of a new project chat**, it
injects the project's curated `OVERVIEW.md` + `CHANGELOG.md` so Claude starts
already knowing the project's current state and history. It's on by default. On a
brand-new project the toggle still appears but is **disabled** (labelled "no
overview yet") until the [sweeper](/concepts/sweeper/) has written an
`OVERVIEW.md` — there's nothing to preload until then.

## Promote a root chat into a project

Not everything starts as a project. A **root chat** — a conversation on the
instance root, belonging to no particular project — is where you think out loud
before you know what it is. If one turns out to be worth keeping, don't
copy-paste it: **promote it**.

From a root chat, click **Promote to project**. Give it a **Project name**
(pre-filled from the chat), and optionally a summary, area, and domain tags:

Paddock then creates a real project **and moves the chat's full history into it**
— transcript and all — so the conversation stays resumable under the new
project's agent. Nothing is lost; the root chat simply becomes the project's
first chat.

:::tip[Start loose, organize later]
This is the intended workflow: brainstorm in a root chat with zero setup, and
only promote to a project once it's clearly something you'll return to. You never
have to decide up front.
:::

## Next steps

- [Projects](/concepts/projects/) — the concept behind notebook vs repo-backed,
  and what a project directory contains.
- [Agents](/concepts/agents/) — the agents that do the work in each project.
- [The sweeper](/concepts/sweeper/) — how `OVERVIEW.md` and `CHANGELOG.md` stay
  curated (and what "Preload project context" injects).
- [Environment variables](/configuration/environment/) — the box-wide defaults
  your per-project settings inherit from.
