---
"@paddock/server": minor
---

The `own → host` transcript migration modal (#882) — the chat-by-chat table, the
submit, and the completion screen. This replaces the placeholder dialog #900
shipped and makes the feature usable end to end.

**The table.** Rows are grouped by project, because the destination is per
project (`~/.claude/projects/<encoded-workingDir>/`) and the group header names
it. Each row carries its classification, and a `diverged` row shows **both
sides** — message counts and last-message times for Paddock's copy and your
`~/.claude` copy — so the choice is informed rather than a coin toss. Rows start
ticked from the server's `defaultSelected`, never from a rule re-derived in the
client: `new` and `fast-forward` are lossless and start checked, `diverged` and
`unknown` start unchecked because a diverged row is a real decision and must be
made deliberately.

**Unticked means preserved, not deleted.** An unticked chat is moved to
`.chats-pre-migration/` beside its project and stays on disk, so there is no bin
icon, no "discard", and no red anywhere in the dialog. The completion screen
renders `preserved[]` **in full, with absolute paths** — that array is the
recovery path, and printing it is what turns "nothing is deleted" from a claim
into something you can check with `ls`.

**It ends by asking for a restart, and says why the chat list looks empty first.**
`claude.transcripts` is frozen at boot, so between the response and the restart
the running server still resolves `own` against a `.chats/` the migration just
emptied — the chat list is blank. Verified on a real instance: a user who is not
told would reasonably conclude the migration destroyed their history.

**A 200 is not a success.** A non-empty `failed[]` means the config was not
written and the instance is still on `own`, so the screen says the migration did
not finish, tells you re-running is safe, and asks you to finish it rather than
restart — restarting would come back on `own` and still not see the chats that
moved.

Submitting with nothing ticked is allowed: "migrate nothing, preserve everything,
flip the lever" is a real choice the API documents, so the button is not disabled
— it changes its label.

`ApiError` now carries the error body's `code` and the parsed `body`. The client
had been discarding both, which made the migration's three different 409s
(`turn_running`, `config_conflict`, `migration_in_progress`) indistinguishable
and left `turn_running`'s `sessionIds` — the list of chats blocking you —
unreachable. The four existing `turn_running` routes benefit for free.
