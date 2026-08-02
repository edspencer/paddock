---
"@paddock/server": minor
"@paddock/web": minor
---

Import the Claude Code CLI chats you already have into a project.

A project is backed by a working directory, and you very often already have
terminal `claude` history for it — or for your own checkout of the same repo,
somewhere else entirely. Until now that history was invisible here.

When a workspace has importable sessions, an **Import _N_ native chats** button
appears at the top of its chat list. One click, no confirmation dialog: the
chats are imported, the list refreshes, and a toast reports how many arrived.
The count is live rather than a dismissable prompt, so it returns if you accrue
new terminal sessions later. Imported chats carry an **Imported** badge so they
are distinguishable from chats started here.

Underneath are two new workspace-scoped routes:

- `GET …/adoptable-chats` → `{ count, sources, filtered }` — what this project
  could import, per source working directory. Recomputed on every call, so the
  count reaches 0 only because there is genuinely nothing left.
- `POST …/adopt-chats` → `{ adopted, skipped }` — imports every detected source,
  or just the one you name.

Both are on the same dual-mounted plugin as the rest of the chat routes, so the
**root workspace** gets them for free. `npm run import-chats -w @paddock/server`
is the headless equivalent, for when the transcripts and the server do not share
a filesystem view — a containerised instance only sees what is mounted.

This requires **`@herdctl/core@5.29.0`**, which is where the session-adoption
primitives live, along with the `CLAUDE_CONFIG_DIR` fix without which *resuming*
an imported chat fails outright.

Detection looks at the project's own working directory plus any Claude
transcript folder whose *recorded* working directory matches the project — by
checkout name for a repo-backed project, by exact path for a notebook one. The
recorded cwd is read out of the transcript rather than derived from the folder
name, because that encoding is lossy and non-invertible: `/a/b-c`, `/a-b/c` and
`/a/b/c` all share one folder. That same lossiness is why sources are
de-duplicated by resolved folder and sessions by id — otherwise a colliding pair
of directories offers every session twice. Empty and slash-command-only
transcripts are withheld as noise and listed under `filtered`, so a lower count
always has an explanation. Results are cached on transcript-directory mtimes and
dropped after every import.

Transcripts are **copied**, never moved: your `~/.claude` history stays intact,
and the copies keep their original timestamps so imported chats sort by when
they actually happened.

Two fixes ride along, both about timestamps and homes being taken for granted:

- The configured `CLAUDE_HOME` is now resolved once and handed to the engine.
  It previously honoured the variable for its own paths while the engine fell
  back to `~/.claude`, so with a non-default home chats could list from one
  directory and open empty from another. Invisible whenever the two happen to
  be the same directory, which is most deployments.
- Relocating an existing transcript directory into a project now preserves file
  timestamps. It didn't, and mtime is both the chat-list sort key and the cache
  key for titles and previews — so a months-old archive collapsed to "today".
  Note the narrow scope: registering an agent still **moves** a matching
  `~/.claude` transcript directory into the project. This stops that move
  mangling the dates; it does not stop the move. Paddock owning its own Claude
  home is filed separately as #620.

Imported chats are marked with a new `adopted` provenance origin. It counts as a
root (nothing here created it) and as *attended* (you ran it yourself), so
importing 22 sessions never claims 22 things ran while you were away.
