---
title: "Concepts"
description: "The core ideas behind Paddock: projects, keeper and scratch agents, chats-as-sessions, schedules, hooks, provenance, and the sweeper."
---

Short, canonical explanations of Paddock's core ideas. Read these to understand
*what things are*; read [`../ARCHITECTURE.md`](/architecture/overview) to understand
*how the code fits together*.

- **[Projects](/concepts/projects)** — a directory + `project.yaml`; the two types,
  **notebook** and **repo-backed**.
- **[Keeper vs. scratch agents](/concepts/keeper-and-scratch)** — one keeper per
  project, one shared scratch, and how a scratch chat is promoted into a project.
- **[Chats are Claude Code sessions](/concepts/chats)** — persisted on disk,
  resumable across reloads, reconnects, and devices.
- **[Schedules](/concepts/schedules)** — durable cron/interval turns that fire when
  nobody is watching; each firing lands as its own chat.
- **[Event hooks](/concepts/hooks)** — run an agent turn when a lifecycle event fires
  (e.g. `onArchive`); its granted tools are its whole capability.
- **[Provenance: who did what](/concepts/provenance)** — how a chat records whether
  a human, a schedule, or another agent started it, and per-message attribution for
  machine-injected turns.
- **[The sweeper](/concepts/sweeper)** — the per-project, post-turn, tool-less agent
  that curates `OVERVIEW.md` and `CHANGELOG.md`.

The one-sentence version: **a _project_ is a directory; its _keeper_ is one
Claude Code agent whose working directory is that directory; a _chat_ is one
resumable Claude Code session belonging to a project; _schedules_ and _hooks_ start
those sessions without you; _provenance_ records who did; and after each turn a
_sweeper_ quietly updates the project's notes.**
