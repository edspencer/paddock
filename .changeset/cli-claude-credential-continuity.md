---
"@paddock/server": patch
---

The `paddock` CLI now uses the Claude Code login you already have, including on
macOS (#683). With no `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` and no explicit
`CLAUDE_HOME`/`CLAUDE_CONFIG_DIR`, it runs against your own `~/.claude` instead of an
isolated home under the data dir.

Since #620 Paddock always set `CLAUDE_CONFIG_DIR`, and Claude Code derives its
secure-storage service name from whether that variable is set at all — so a Keychain
login made under the plain name became invisible. The `.credentials.json` bridge
covers the file-based store and is structurally incapable of covering macOS. The
result was `npx @edspencer/paddock --here` booting fine and failing every turn with
`Not logged in`, on the platform the npx story is aimed at.

Continuity means transcripts stay in `~/.claude/projects/` rather than being relocated
into the workspace's `.chats/`. Paddock still writes nothing there (#682), and import
consent is unchanged — existing sessions are offered, not opened, exactly as before.
Pass `--isolated-claude-home` for the previous behaviour; a server, the container image
and `node dist/index.js` are unchanged.

Also: on macOS, when Paddock does hold its own home and finds no credential, it now
probes the Keychain and — if a login is there — says so and gives the exact command,
instead of a generic "no credentials found". The secret is never read or copied.
