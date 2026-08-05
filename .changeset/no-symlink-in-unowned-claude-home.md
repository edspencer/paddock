---
"@paddock/server": patch
---

Never plant a transcript symlink in a Claude home Paddock does not own (#682).
`ensureProjectChats` gated its two existing-directory branches on `home.owned` but
not the "nothing there yet" one, so with `CLAUDE_HOME=~/.claude` a directory with no
prior transcripts got `~/.claude/projects/<encoded-cwd>` replaced by a link to the
workspace's `.chats/`. From then on every `claude` session started in that directory
was written into Paddock's store, and deleting that store — an ordinary thing to do —
destroyed transcripts Paddock never owned. Reported on a real laptop: 30 sessions lost.

Paddock now creates nothing in an unowned home; transcripts stay where Claude Code
writes them and adoption remains the user-driven way to import them. Boot also warns
about links an affected build already planted, naming each path. Nothing is deleted
automatically — Paddock does not write to `~/.claude`, and that has to include
cleaning up after itself.
