---
"@paddock/server": minor
---

`claude.instructions` and `claude.hooks` — your `~/.claude` prompts and hooks are
no longer inherited unconditionally (#691 step 4).

```yaml
claude:
  instructions: own   # own | host — default own: CLAUDE.md, agents/, commands/, plugins/
  hooks: own          # own | host — default own: the hooks key of settings.json
```

Until now, relocating the Claude home was followed by symlinking the whole of
your user-level config back into it — `settings.json`, `CLAUDE.md`, `agents/`,
`commands/`, `plugins/` — with no key to turn any of it off. The half that
matters is `hooks`: those are **shell commands** your `settings.json` binds to
tool use and session lifecycle, and they ran inside every Paddock turn whether or
not anyone chose that. "Isolate it by just trying Paddock" was not true, and this
is why.

**`hooks: own` is not a symlink decision.** `settings.json` carries `hooks` *and*
`permissions`, `model`, `statusLine`, `enabledPlugins`; a symlink is
all-or-nothing and the file is not. So Paddock writes its own `settings.json`
into its Claude home carrying your other keys with `hooks` dropped. It is
regenerated at every startup, so a restart is what applies an edit to yours —
and only files that actually define hooks are copied at all, so most instances
keep the symlink and nothing can go stale. A `settings.json` you put in Paddock's
own home is recognised by hash and never overwritten; an unparseable source
plants nothing rather than falling back to the symlink.

**`instructions: own` is a deliberate reversal, and smaller than it looks.** The
argument against it — shipped in #620's own docstring — is that your curated
`~/.claude/CLAUDE.md` silently stops reaching your agents. Its premise turns out
not to hold for the runtime Paddock runs chats on: user memory, `agents/` and
`commands/` move with Claude Code's `user` setting source, which Paddock's agents
do not load, so on a default chat turn these have been inert since chats moved to
the SDK runtime. They do apply to the sweeper, triggers and `batch` chats. It is
the default anyway because *"`own` everywhere means nothing outside the data dir
is read or written"* has to be a guarantee you can read off a config file, not a
guarantee with a permanent footnote. Paddock names the key at startup when it
finds files it is not loading; each project's own `CLAUDE.md` is unaffected.

Both take `PADDOCK_CLAUDE_INSTRUCTIONS` / `PADDOCK_CLAUDE_HOOKS`, env > file >
default, and both withdraw a symlink a previous `host` boot planted.

**Scope, and a caveat found while building this.** `<claude-home>/settings.json`
is Claude Code's `userSettings` source, and herdctl invokes the Agent SDK with
`--setting-sources=project` for every agent that has a working directory — which
is every Paddock agent. So a default chat turn never reads that file; the CLI
paths (the sweeper, triggers, `driveMode: batch`) pass no such flag and do. The
host's hooks therefore execute in those paths and not, today, in an SDK chat
turn. Narrower than it looked, still real code execution, and the asymmetry is a
herdctl default rather than a guarantee.

Scope worth stating: `hooks: own` means *no host hooks*, not *no host commands*.
`settings.json` has several other keys that name a script to run — `apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper`,
`otelHeadersHelper`, `statusLine`, `subagentStatusLine` — and they are still
inherited. Where they belong is an open question on #691.
