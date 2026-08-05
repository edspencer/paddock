---
"@paddock/server": minor
---

`claude.mcpServers` — your own MCP servers can now reach your Paddock agents
(#691 step 5, the last of the five levers).

```yaml
claude:
  mcpServers: own   # own | host — default own
```

`host` attaches the servers you added with `claude mcp add`: the top-level
`mcpServers` of your `~/.claude.json` (user scope, every project) plus any under
`projects.<absolute-dir>.mcpServers` (directory scope), which a project gets only
when that directory is its own working directory. `own` (the default) attaches
only what Paddock provides itself. Also `PADDOCK_CLAUDE_MCP_SERVERS`, env > file
> default. The boot log names every server attached, and every one it could not
carry.

**Why this key is not a symlink like the others.** MCP servers are not declared
inside `~/.claude` at all — they live in **`~/.claude.json`**, a sibling *file*
next to that directory, because Claude Code resolves it as
`<config-dir-or-home>/.claude.json`. Once Paddock owns its own Claude home, no
bridge of entries *inside* the home can reach it, which is why MCP inheritance
broke silently and separately from everything else. So `host` is a **read**:
Paddock reads that file once at startup and passes the servers to the runtime. It
deliberately does not symlink it, because Claude Code writes to it (per-project
trust, server approvals, migration flags) and bridging it would mean a Paddock
instance mutating your real config.

Read once, at boot — add a server and restart Paddock to pick it up.

**Two caveats found while building this, each warned about by name at startup.**
The engine's MCP schema has fields for `command`, `args`, `env` and `url` only, so
an http/sse server's **`headers` are dropped** (a bearer token is lost — and
because MCP OAuth tokens are keyed on a hash of `{type, url, headers}`, its stored
token is not found either), and **`type: sse` is connected to as HTTP**. A stdio
server, which is most of them, is carried exactly. A server declaring neither a
`command` nor a `url` is skipped.

**MCP logins do follow `claude.credentials`** — an open question on #691, now
answered from the bundled CLI: OAuth tokens live under an `mcpOAuth` key in the
*same* credential store as your Anthropic login, resolved by the same variable
`claude.credentials` drives. There is no separate MCP token store, so
`credentials: host` (the default) carries them and `credentials: own` means
re-authorising inside Paddock.

**Plugins are not covered, and #691's reasoning for why turns out to be wrong.**
The design says the SDK does not auto-discover installed plugins; it does — the
plugin root is the Claude home and discovery is real. What actually blocks it is
that discovery is gated on `enabledPlugins` in the home's `settings.json`, which
Paddock's agents never load (they run with only the *project* setting source), and
that herdctl exposes no way to pass a plugin per session. Both are outside this
change. Until then a plugin's MCP server has to be declared directly with
`claude mcp add`.

Declaring a server *only* for Paddock is still #691 step 6. Today:
`CLAUDE_CONFIG_DIR=<data-dir>/claude-home claude mcp add …`, or a per-project
`.mcp.json`.
