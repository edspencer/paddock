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

**`instructions: own` is a deliberate reversal, and it has a cost.** If you have
curated a `~/.claude/CLAUDE.md`, your Paddock agents stop seeing it — no error,
just different behaviour. That is a real regression and the argument against it
was shipped in #620's own docstring. It is the default anyway because *"`own`
everywhere means nothing outside the data dir is read or written"* has to be a
guarantee you can read off a config file, not a guarantee with a permanent
footnote. Paddock names the key at startup when it finds files it is not loading,
and each project's own `CLAUDE.md` is unaffected either way.

Both take `PADDOCK_CLAUDE_INSTRUCTIONS` / `PADDOCK_CLAUDE_HOOKS`, env > file >
default, and both withdraw a symlink a previous `host` boot planted.

Scope worth stating: `hooks: own` means *no host hooks*, not *no host commands*.
`settings.json` has several other keys that name a script to run — `apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper`,
`otelHeadersHelper`, `statusLine`, `subagentStatusLine` — and they are still
inherited. Where they belong is an open question on #691.
