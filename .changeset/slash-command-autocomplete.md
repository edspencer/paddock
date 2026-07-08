---
"@paddock/server": minor
"@paddock/web": minor
---

Slash-command autocomplete in the composer (#103).

Typing `/` as the first character of the composer now pops a keyboard-navigable
menu of the commands available to the chat's agent — built-ins (`/compact`,
`/clear`, …) plus the project's `.claude/commands` and any MCP-provided commands.
The menu filters by the text after the slash (case-insensitive substring on the
name), shows each command's name / argument hint / description, and supports
ArrowUp/ArrowDown to move, Enter/Tab to accept, Escape to dismiss, and
mouse hover/click. Accepting inserts `/name ` and closes the menu; a fully-typed
command sent with Enter still routes through the existing `sendCommand` path
unchanged (this is discovery/entry assistance only).

Server: a cached, read-only `GET /api/projects/:slug/commands` (and a
`GET /api/commands` scratch equivalent) backed by `@herdctl/core`'s new
`FleetManager.listAgentCommands` (herdctl#300). The list is stable per project
and each underlying call spawns a short-lived `claude` streaming subprocess, so
`HerdctlService.listCommands` memoizes per agent for the process lifetime and
de-duplicates concurrent first calls into a single subprocess. Bumps
`@herdctl/core` to `^5.16.0` for the new API and re-exported `SlashCommand` type.
