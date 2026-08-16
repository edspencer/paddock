---
"@paddock/server": patch
---

Flipping `claude.transcripts` from `host` back to `own` no longer leaves the
instance writing into — and deleting from — your real `~/.claude` (#708).

`host` plants a symlink at `<project>/.chats` pointing out at
`~/.claude/projects/<encoded-cwd>/`. Nothing ever removed it. Set the key back to
`own` and that link stayed, leaving a two-hop chain into your own Claude home
that `mkdir -p` could not heal, because `mkdir(recursive)` over a
symlink-to-an-existing-directory is a silent no-op. Three consecutive `own` boots
did not fix it.

Two consequences, both reproduced on a running instance before the fix and
verified gone after it:

- **`own` stopped isolating.** A chat created after the flip was written into the
  user's real Claude home, falsifying the guarantee the mode exists to make.
- **Deleting a chat destroyed history Paddock never owned.** The `own` branch of
  the delete `rm`s the transcript, on the reasoning that under `own` the file is
  Paddock's own copy. Through the stale link it resolved to the user's file
  instead, and returned `removed: true` while unlinking a chat they had only ever
  had in a terminal. The same destruction class as #682, re-entered through a
  config flip rather than a bad build.

`ensureProjectChats` now unplants a stale `.chats` symlink under `own` and puts a
real directory back, on every boot and for sweeper homes too. `deleteSession`
additionally refuses to run its `rm` while a store is still a planted symlink —
the healing swallows its own errors by design, and this is the one operation that
must not proceed on an unhealed layout.

**What it deliberately does not do: migrate.** The transcripts written during the
`host` period stay exactly where they are, unread and unmoved, and therefore
leave Paddock's chat list. Copying them in was rejected because it cannot be done
without reading `~/.claude` — the very thing `own` promises not to do, and the
falsification of which is the bug being fixed here — and because that folder
holds whatever you ran `claude` on in that directory, including chats you never
had in Paddock at all. Paddock already has a user-driven feature for this
(`Import chats`, which copies), and it should stay the user's choice.

A boot warning names each project's store and the folder its chats are still in.
It also states the limit honestly, which was measured rather than assumed: import
offers your terminal sessions but excludes anything a run record is attributed
to, so chats Paddock itself drove during the `host` period are not offered.
Moving those needs the migration designed in #882.

The `own → host` direction is unchanged and still has no cleanup step; that half
of #708 is #882's.
