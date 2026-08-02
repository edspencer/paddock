---
"@paddock/server": minor
---

Paddock now owns its Claude home; `~/.claude` is a read-only source (#620)

Claude Code's transcripts were the one piece of state Paddock did not keep under
its own data dir. They lived in the user's `~/.claude`, reached by planting
symlinks into it from outside — and `ensureProjectChats` would, on every agent
registration and inside a bare `catch {}`, copy a user's existing transcripts out
of there and **delete the originals**. That fired in exactly the case the chat
import (#588) exists to serve: pointing a project at a directory you already have
terminal `claude` history for.

That layout was forced, not chosen: until herdctl#423 nothing set
`CLAUDE_CONFIG_DIR`, so the SDK wrote to `~/.claude` whatever home Paddock
configured. With `@herdctl/core@5.29.0` that constraint is gone.

- The Claude home now defaults to **`<dataDir>/claude-home`**, making a data dir
  movable, backable and wipeable as a unit. Precedence is `CLAUDE_HOME`, then
  `CLAUDE_CONFIG_DIR`, then a `claudeHome:` config-file key, then the default.
- **Paddock never moves or deletes anything under `~/.claude`.** The destructive
  migrate branch is gated on owning the home, so in the user's home it does
  nothing at all.
- **Chat import still reads `~/.claude`** — the user's transcript folders are
  mirrored into Paddock's home read-only, so a source is copied out of and never
  written to.
- **Agent memory writes work.** Claude Code keeps per-project memory at
  `<claudeHome>/projects/<enc-cwd>/memory/`; with no `.claude` path component the
  harness restriction that blocked writes there no longer applies.
- User-level config in `~/.claude` (`.credentials.json`, `settings.json`,
  `CLAUDE.md`, `agents/`, `commands/`, `plugins/`) is symlinked into the new home
  when it has none of its own, so relocating does not drop your memory,
  permissions or login.

**No data migration is required or performed.** Paddock-managed transcripts
already live in `<projectDir>/.chats/`; only the redirect symlink moves. The
symlinks a previous version planted in `~/.claude/projects/` are left in place
(nothing reads them any more) and reported once at boot so they can be cleaned up.

**Upgrading with a keychain-based login:** Claude Code scopes its credential store
to whether `CLAUDE_CONFIG_DIR` is set, so a login held in the OS keychain against
the default home is not found under the new one. Token-in-environment setups
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) and file-based logins are
unaffected — the latter are bridged. Paddock warns at boot when it can find no
credential source, and `CLAUDE_HOME=$HOME/.claude` restores the previous layout
exactly.
