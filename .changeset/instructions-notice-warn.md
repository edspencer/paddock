---
"@paddock/server": patch
---

The `claude.instructions: own` startup notice is now a warning, so you actually
see it. It names which of your `~/.claude` files (`CLAUDE.md`, `agents/`,
`commands/`, `plugins/`) are not being loaded and which key turns them back on —
but it was written at `info`, and `npx @edspencer/paddock` sets `LOG_LEVEL=warn`
unless you pass `--verbose`, so on the documented install path the one population
the notice exists for never saw it (#706). It still says nothing when you have no
such files, or when you are on `claude.instructions: host`.
