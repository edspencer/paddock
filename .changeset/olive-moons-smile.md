---
"@paddock/server": patch
---

CLI: tell the truth about `--here` and stop double-warning about credentials

`--here` no longer links the user's `~/.claude` transcripts into the workspace —
since #620/#634 `ensureProjectChats` bails out inside a home Paddock does not own,
so those sessions are left exactly where they are and surface as an *import offer*
(which since #663 also asks for confirmation). Two consent strings still described
the old behaviour and now describe the real one.

The `npx paddock` preflight also printed its own "No Claude credentials found"
warning immediately before the boot-time one from `ensureClaudeHome`. The
preflight checked the *legacy* `~/.claude` rather than the home Paddock actually
uses, and treated a bare `~/.claude.json` as proof of a login — so it could stay
silent while Paddock's own home held no credentials at all. It is removed; the
boot notice checks the right directory, runs after the credential bridge, and
explains the `CLAUDE_CONFIG_DIR` keychain scoping that causes the failure.
