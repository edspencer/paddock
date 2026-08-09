# Paddock concepts

<!-- superseded-banner -->
> [!WARNING]
> **Superseded — this is a stale fork, not the maintained page.**
> Read **[Concepts](https://paddock.edspencer.net/concepts/)** instead
> (source: [`website/src/content/docs/concepts/index.md`](https://github.com/edspencer/paddock/blob/main/website/src/content/docs/concepts/index.md)).
>
> This copy is not updated against releases and has already been wrong about
> live behaviour in ways that break a server. It survives only because other
> files still link to it. Do not patch it — patch the website copy.

Short explanations of Paddock's core ideas. Read these to understand
*what things are*; read [`../ARCHITECTURE.md`](../ARCHITECTURE.md) to understand
*how the code fits together*.

- **[Projects](./projects.md)** — a directory + `project.yaml`; the two types,
  **notebook** and **repo-backed**.
- **[Agents](./agents.md)** — one agent per project (the root included), and how
  a chat is promoted into a project of its own.
- **[Chats are Claude Code sessions](./chats.md)** — persisted on disk,
  resumable across reloads, reconnects, and devices.
- **[The sweeper](./sweeper.md)** — the per-project, post-turn, tool-less agent
  that curates `OVERVIEW.md` and `CHANGELOG.md`.

The one-sentence version: **a _project_ is a directory; Paddock runs one
Claude Code agent whose working directory is that directory; a _chat_ is one
resumable Claude Code session belonging to a project; and after each of your
turns a _sweeper_ quietly updates the project's notes.**
