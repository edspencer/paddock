---
"@paddock/server": minor
---

`claude.credentials: own | host` — Paddock uses the Claude Code login you already
have (#691 step 3, fixes the #683 regression 0.61.1's successor introduced).

```yaml
claude:
  credentials: host   # own | host — default host
```

Making Paddock always own its Claude home fixed four things and broke one: Claude
Code files its secure-storage entry under a service name derived from
`CLAUDE_CONFIG_DIR`, so the moment Paddock set that variable, a macOS `claude
/login` became invisible. On a Mac with no token in the environment that is an
instance which boots cleanly, reports itself ready, and fails every single turn
with "Not logged in". This is the lever that gets the login back without giving
the Claude home back.

- **`host` (the default)** — Paddock uses this machine's Claude Code login: the
  macOS Keychain entry on darwin, your `~/.claude/.credentials.json` elsewhere
  (symlinked in, never copied). Nothing else travels with it.
- **`own`** — only a login of this instance's: a `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_API_KEY` in the environment, or a `.credentials.json` inside
  Paddock's own Claude home. A `.credentials.json` symlink a previous boot
  bridged in is withdrawn.

`PADDOCK_CLAUDE_CREDENTIALS` overrides the file, as usual.

**This is the one key in the `claude:` block that defaults to `host`, and the
exception is deliberate: isolation is about writes.** Reading a Keychain entry
creates, moves and deletes nothing of yours; defaulting it to `own` would
recreate #683 for every Mac user who has never exported a token. The guarantee
`own` everywhere buys — nothing outside the data dir is written — is untouched by
it.

Mechanically, `host` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` in the environment
the runtime gets. Claude Code resolves its secure-storage scope from that
variable *instead of* `CLAUDE_CONFIG_DIR` whenever it is defined, and the empty
value selects the unsuffixed service name — the entry a plain `claude /login`
wrote — while Paddock's config dir stays exactly where it is. One variable, no
home moved, nothing else shared. Set the variable yourself to a non-empty value
and Paddock honours yours instead, saying so at startup.

Also: the darwin Keychain probe #686 shipped flagged as unverified is now
**confirmed correct** — the service name is exactly `Claude Code-credentials` —
and the boot notice knows about the lever, so a found Keychain login under
`credentials: host` is reported as the login being used rather than warned about
as a login that cannot be seen.
