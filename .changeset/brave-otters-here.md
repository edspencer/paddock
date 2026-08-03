---
"@paddock/server": minor
---

`paddock --here` — open the current directory as a workspace (#640)

```sh
cd ~/code/myapp
npx @edspencer/paddock --here
```

Paddock opens **that directory** as its workspace: Claude works in your files,
and the Claude Code sessions you already have for the directory are offered for
import.

**This needed no new concept.** A *project* cannot live outside `projectsRoot`,
but the **root workspace** is a different thing — its key is `""`, so
`dirFor("")` resolves to `projectsRoot` itself, and `projectsRoot` is already
user-configurable. Session adoption then matches by construction, because
`AdoptableIndex`'s notebook branch is exact `cwd === workingDir` equality and
here the workspace's working directory IS your cwd.

**A bare `npx @edspencer/paddock` still touches nothing.** It starts the server
against `~/.paddock` as before. If the directory you happen to be in has Claude
sessions, it says so and names the flag — read-only, nothing written.

**The flag is the consent.** No prompt, no `--yes` to remember. Because consent
means nothing if you cannot know what you agreed to, `--here` *announces* what it
does on the run that does it: creates `.paddock/` (this workspace's own state)
and `.chats/`, adds both to `.gitignore` (appending — your rules are preserved),
and links `~/.claude/projects/<encoded-dir>` at the workspace.

**Later runs in that directory resume it with no flag** — the `git` model, where
`--here` is `git init` and `.paddock/` is `.git`. `.paddock/` was chosen over
`project.yaml` as the marker precisely because it is unambiguous: `project.yaml`
already exists in the wild and would make unrelated directories auto-adopt.

State lives in `<dir>/.paddock` rather than the shared `~/.paddock`, so opening
two directories does not have them share one job store and leak each other's run
history.

Every run now names its workspace on startup — behaviour that varies with cwd is
only safe if it is observable.
