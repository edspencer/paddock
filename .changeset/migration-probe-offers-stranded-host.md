---
"@paddock/server": patch
---

Offer the transcript migration to instances stranded on `host` (#708, #882)

`GET /api/transcripts/migration` refused with `already-host` whenever the
instance resolved `claude.transcripts: host`, on the reasoning "already
migrated, nothing to offer". That was wrong for the users with the most to
recover: an instance that flipped to `host` while `.chats/` was still non-empty
is #708's stranded state — `pointChatsDirAt` declines to plant the redirect
symlink against a non-empty real directory, so the pre-flip transcripts sit in a
`.chats/` nothing can read, and the probe told exactly those users there was
nothing to do.

Eligibility is now "`.chats/` is a non-empty real directory", independent of
mode. Under `host` the distinction is the directory, not the mode: a `.chats`
symlink into the host store or an empty real directory is the healthy,
already-migrated instance and still reports `already-host`; only a non-empty
real directory is eligible.

Also fixes `ok` on the execute side. Under `host` the run is a recovery rather
than a flip — it moves the files and correctly skips the config write — but `ok`
was keyed on `configWritten`, so a run that recovered every stranded chat and
emptied every `.chats/` reported `ok: false`, while the dry run that predicted
it reported `ok: true`.

Closes the `own → host` half of #708 that #897 left open.
