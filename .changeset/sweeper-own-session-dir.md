---
"@paddock/server": patch
---

Give the sweeper its own working directory, so a chat can no longer be bound to
the curator's transcript (#548).

A CLI agent's `working_directory` is what Claude Code encodes into its transcript
path, so two agents sharing a cwd share one session directory. The keeper's cwd
is `project.workingDir` and the sweeper's was `project.dir` — **identical for a
notebook project**, so both wrote their transcripts into the same `.chats/`.

herdctl identifies a freshly-spawned session by set-difference against a
pre-spawn snapshot of that directory. That is immune to a co-located agent
*appending* to its own session, but not to one *creating* a new file: whichever
brand-new `*.jsonl` appears first is claimed as "ours". Since a sweep is
scheduled after every keeper turn — with **zero delay** after a project's first
turn, because the interval watermark is still unset — the sweeper's spawn raced
the following keeper turn. When the sweeper's file landed first, the user's turn
was handed the sweeper's session id, and the consequences all followed from that
one substitution: the curation text streamed back as the reply, resuming the chat
resumed the curation transcript (so the keeper had no memory of the conversation),
and the chat could vanish from the project's list entirely — the sweeper is the
one deliberately hidden agent, so a session attributed to it is filtered out.

The sweeper is tool-less: it reads nothing and writes nothing, because
`SweepService` gathers the project's files itself, inlines them in the prompt, and
writes the curated results itself. Its cwd was therefore inert, and moving it to a
dedicated per-project directory under the data root removes the shared directory —
and with it the whole collision class — structurally rather than by timing. The
directory is kept outside `projectsRoot` on purpose: core's discovery unions every
transcript bucket whose decoded path is a strict descendant of an agent's cwd, and
the root workspace's cwd *is* `projectsRoot`.

Existing sweeper transcripts stay where they are and are simply no longer read;
they were never surfaced in the UI (the sweeper is hidden), and curation does not
consult its own history.

This was the whole of paddock#548, the intermittent `packages/server` integration
failure that made a red CI indistinguishable from a real regression. It presented
as three unrelated-looking assertions — a renamed chat missing from the list, a
resumed chat that had forgotten its codeword, and a transcript read that came back
empty — and it explains the otherwise-odd invariant that a failing run always
failed *exactly one* test: there is only one prompt sweeper spawn per project, so
at most one turn could be hijacked.
