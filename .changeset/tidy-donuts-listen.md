---
"@paddock/server": minor
"@paddock/web": minor
---

Link an existing on-box directory as a project's working directory (#206).

A new `path:` field on `project.yaml` — and an **Existing directory on this
machine** field in the New project dialog — points a project's agent at a git
checkout you already have (`/home/ed/Code/foo`), used **in place, with no copy**.
Where `repo:` clones a fresh copy into a nested checkout, `path:` makes your real
clone the working directory: its history, its branches, its remotes.

**Paddock writes zero files into a linked directory.** No `.chats/`, no sidecar
`.gitignore`, no seeded `CLAUDE.md` — transcripts stay in the project's own folder
in the data dir, and `git status` in your checkout is unchanged. Deleting the
project removes only Paddock's metadata directory; the linked directory is never
touched.

Two things start working that could not before, because both key on the agent's
working directory and a cloned checkout is a directory you have never opened a
terminal in: prior `claude` sessions in that directory are offered for adoption,
and `claude.transcripts: host` plus your `~/.claude.json` per-directory MCP
servers now match.

`path:` is validated at creation (absolute, exists, is a directory containing
`.git`, and outside the projects root, the data dir, and every other project's
working directory — with symlinks resolved before those checks) and is immutable
thereafter. It may be combined with `repo:`, which then records only *which* repo
the directory is, for session matching and as a re-clone hint; nothing is cloned.
