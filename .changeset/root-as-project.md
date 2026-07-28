---
"@paddock/server": minor
"@paddock/web": minor
---

feat: the root is a project — root Home and root chats (#516, Phases 1–3).

A Paddock instance can now be as capable at its root as inside any project. The
framing: **the root is the project whose directory is `projectsRoot` instead of
a subdirectory of it.** Its keeper is an ordinary keeper — same
`buildKeeperConfig`, same self-MCP, same `max_concurrent: 10`, same chat tree,
same per-chat model, same sweeper. Nothing is special-cased; one assumption
about where a project directory sits is relaxed.

`ProjectStore.dirFor()` is the single resolution seam: the reserved `__root`
slug maps to the projects root itself, so read/update/overview/changelog/file
serving all work on it unchanged. `list()` is untouched — it only walks
subdirectories, so the root stays out of enumeration and is resolved explicitly
at boot. New `GET`/`POST /api/root-project` ask whether an instance has one and
create it; everything else goes through the ordinary `/api/projects/__root/…`.

In the web, `urls.ts` generalises `slug` → `base` (`""` at the root,
`/projects/:slug` otherwise), so one `ProjectView` serves both. Root URLs are
flat and top-level: `/` is root Home and `/chat[/:sessionId]` its chats, with
the projects grid moving to `/projects`. `/` always renders Home — no redirect
and no sticky last tab, so the instance's front door never lands on Files.

**Migration is gated on existence, so nothing changes for an existing
instance.** Nothing seeds `<projectsRoot>/project.yaml`; without it there is no
root project, `/` is the projects grid and `/chat` is a scratch chat exactly as
before. Creating the root project — an "Enable" card on the grid — is the whole
opt-in.

Worth being blunt about the escalation it buys: the root keeper's working
directory CONTAINS every project, so root chats can read and edit any project's
files. That is the intent — the root is where you act across the instance — but
it is a real step up from a project keeper, which is confined to its own
subtree.

Files, Changes, History, Settings and retiring scratch are follow-up phases;
their tabs are hidden at the root rather than pointed at URLs that don't
resolve. Note that once a root project exists, `/chat` is a root chat, so
existing scratch chats are not reachable in the UI until that final phase
re-homes them — their transcripts are untouched on disk.
