---
"@paddock/web": patch
---

The UI now says **adopt** instead of **import** for bringing in your terminal
`claude` history (#744).

Reported from real use: an instance running `claude.transcripts: host` offered to
"Import 20 native chats", which read as though Paddock was about to copy 20
transcripts somewhere. It wasn't. Under `host` the project's `.chats` is a
symlink straight at `~/.claude/projects/<encoded-cwd>/`, so the offered sessions
are *already* inside the project's transcript store — the action registers them
so they appear in the chat list, and moves nothing.

The backend has always called this adoption (`/adopt-chats`, `adoptChats`,
`ADOPTED_ROOT`); the UI was the only layer using a second vocabulary, and the
existing test names carried the translation inline ("badges an adopted (imported
from the CLI) chat"). So this is an alignment fix, not a new word.

Renamed unconditionally rather than per-transcripts-mode: a mode-conditional
label would make the same button say different things depending on a setting the
user may not remember. "Adopt" is accurate either way — under the default `own`
the action copies *and* adopts, and adopt is the user-meaningful half.

- The sidebar affordance, its accessible name, and the confirmation dialog
  (`ImportChatsModal` → `AdoptChatsModal`).
- The `adopted` provenance badge and the History tab's run chip, which said
  "Imported" — a button saying "Adopt" that yields a chat badged "Imported" is
  the same confusion one step later.
- The outcome toasts ("Adopted 7 chats", "Removed 2 adopted chats").

The dialog also no longer claims your `~/.claude` history "is copied, never
moved" — true under `own`, but wrong under `host`, where nothing is copied at
all. It now states the invariant that holds in both modes: your originals are
never moved or deleted.

No API change: the REST routes, the `npm run import-chats` script, and
`@herdctl/core` are untouched.
