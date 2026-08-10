---
"@paddock/server": minor
---

Remove `--here`, and with it the per-directory instance (#798).

`--here` opened the directory you were standing in as the workspace, with its own
data dir at `<dir>/.paddock`. Discover (#745) does the job it was built for from
**one** instance with as many linked directories as you like — which is also the
only shape that can run as a background service (#796), since a launchd agent
hosts exactly one instance and three `--here` directories were three instances.

**It also deletes a live bug.** The marker for "this directory is a workspace" was
a `.paddock/` folder — the same name as the default data dir at `~/.paddock`. So
on any machine where paddock had ever run bare, a later bare run from `$HOME`
matched `isHereWorkspace($HOME)`, resumed the entire home directory as the
workspace, wrote a `~/.gitignore` and created `~/.chats`. An explicit `--data-dir`
was honoured and did not help — `PADDOCK_PROJECTS_DIR = cwd` was set
independently — and because it read as a resume rather than a first open, the
consent announcement was skipped. The only tell was the word `(resumed)`.

The CLI no longer reads `process.cwd()` at all, and no longer writes into any
directory: `PADDOCK_PROJECTS_DIR` was only ever set here, and is now left to the
server's own default of `<dataDir>/projects`. It remains a supported environment
variable. The startup line names the data dir rather than a workspace, and
`--data-dir` is the only thing that picks which instance you get.

The bare-run hint that counted the current directory's Claude Code sessions and
suggested `paddock --here` is gone too — both halves of it were the problem. The
first-run welcome now points at the app, where Discover reads the whole history
rather than one directory and can show it with tick-boxes.

No migration: there were no users. If you did open a directory with `--here`, its
state is the `.paddock/` and `.chats/` folders inside it — add the directory
through Discover to bring its conversations across, then delete those two folders
and the two lines `--here` added to your `.gitignore`.
