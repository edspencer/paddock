---
"@paddock/server": minor
---

Run the `own → host` transcript migration (#882): `POST /api/transcripts/migration`
quiesces every project, re-enumerates `.chats/` from disk, moves the files, and —
only if every project ends with an empty `.chats/` — writes `claude.transcripts: host`.

That last write is the commit point and is deliberately last. Until it lands
nothing has semantically happened: the running server still resolves `own`, and a
partly-emptied `.chats/` is the transient blank-list state the flow already warns
about, which re-running reconciles. The reverse order would leave a config saying
`host` and files still in `.chats/` — a genuine #708 split rather than a blank list.

**Nothing is ever deleted, and nothing in your own `~/.claude` is overwritten in
place.** Where the same chat exists on both sides, the copy that does not survive
is *moved* to `<project-dir>/.chats-pre-migration/` — a sibling of `.chats/`, not
a child, because a child would leave `.chats/` non-empty and make the redirect
symlink be declined, shipping #708's own symptom from the migration built to fix
it. When Paddock's copy supersedes yours (a fast-forward Paddock is ahead on, or
a chat you ticked that diverged), yours is moved aside *first* and the
replacement lands on an empty destination. The response lists every preserved
file by path.

This replaces the design's skip-if-present move rule, which deadlocked against
the empty-`.chats/` postcondition: for any chat present on both sides the
destination existed, the move skipped, the file stayed, and the config was never
written. On an instance where you adopted your CLI history and then worked in
both places that is *every* chat — the feature would have failed hardest for the
person it was designed for.

`memory/` is merged file by file under the same rule, so a hand-curated
`MEMORY.md` you already have is never clobbered. Sweeper stores migrate silently
with their project. A running turn refuses the whole migration with
`409 turn_running` and nothing moved; a stale `expectedVersion` gives
`409 config_conflict`; a second execute gives `409 migration_in_progress`; a
`PADDOCK_CLAUDE_TRANSCRIPTS` shadowing the config file gives `400 env_shadowed`,
because the write would be inert and the transcripts would have moved for
nothing. A repeat POST is idempotent, not an error.

The shared move helper underneath it (`rename` first, copy on `EXDEV`, and a
refusal rather than the silent clobber POSIX `rename(2)` would give you) is also
the fix for `promoteSession` orphaning `subagents/` and `.reverts/` — filed
separately as #898.
