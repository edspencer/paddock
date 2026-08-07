---
"@paddock/server": minor
"@paddock/web": minor
---

Projects are described by two independent axes instead of one overloaded flag,
and a project can point at a directory you already have (#206, #597).

**`managed` replaces `repoBacked`.** A project is *managed* when Paddock looks
after its own files — the sweeper curating `CLAUDE.md`, `OVERVIEW.md` and
`CHANGELOG.md`, which is what "notebook" used to mean — and *unmanaged* when the
content is code you or your agents source-control outside Paddock. Whether a git
repo sits behind it is a separate question, and not a type: it is just which of
`path` and `repo` are set. `repoBacked` was one boolean answering four questions
and has been removed from the DTO; each consumer now takes the fact it needs.

**`path:` — where a project's content lives.** An absolute directory, applying to
both axes. Unmanaged, it links a checkout you already have — used in place, with
no copy, so Claude gets its real history, branches and remotes; Paddock writes
nothing into it (no `.chats/`, no sidecar `.gitignore`, no `CLAUDE.md`), and
deleting the project never touches it. Managed, it nominates where your notes
live, and the curated trio follows the content out there — an accepted
consequence being that those three files then do not live in the Paddock data
dir. Either way `project.yaml` (the registry entry) and `.chats/` stay put.

Acquisition follows from what you give it: an existing path is used as-is (with a
warning, not a failure, if a declared `repo`'s remote doesn't match it); a missing
path is cloned into when a `repo` is given, or created for a managed project. A
failed create only ever removes directories it made during that attempt, never
one that already existed.

**No git requirement.** Paddock probes for git and lights up the git features when
it finds a repository; it never rejects a directory for not being one.

**The Changes tab reports on the working directory (#597).** It read the metadata
directory before, so for a repo-backed project it showed the notes folder rather
than the code — and repo detection was asked of the projects root rather than the
directory in question. Both are now per-directory.

`managed` is optional on disk and its default is derived (`managed ?? !(repo ||
path)`) so existing `project.yaml` files keep their current meaning on upgrade;
`managed: true` together with `repo` is rejected rather than silently reinterpreted.
`managed` and `path` are immutable after creation.
