---
"@paddock/server": patch
---

Stop offering Paddock's own sweeper runs as native chats to import

The "Import N native chats" button could offer back the sweeper's own curation
transcripts. On the dogfooding instance, 10 of the 26 chats the `paddock`
project offered were Paddock's output, not the user's terminal history.

The sweeper is a one-shot `claude -p` subprocess, so it writes an ordinary
transcript into the project's own chat folder. Adoption relies on the engine's
attribution to exclude "sessions a real Paddock run owns", and attribution is
driven by run records — but no `job-*.yaml` binds those ten session ids. With no
run record, a sweeper transcript is indistinguishable from a session the user
typed in a terminal, so it was offered for import.

Curation runs are now recognised by their prompt's opening (the
`Project: <name> (slug: <slug>)` header plus the `You are curating` sentence) and
withheld under a new `sweeper-run` filter reason. Like the existing `too-small`
and `slash-command-only` reasons they are reported in `filtered` rather than
dropped silently, so the count always has an explanation.

The rule is asserted against the prompt `SweepService` really builds, not a copy
of it — the wording has drifted once already ("curating two files in this project
directory" → "curating this project's three context files"), and a stale copy
would have let the filter drift with it.
