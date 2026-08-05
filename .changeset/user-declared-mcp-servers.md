---
"@paddock/server": minor
---

`mcpServers:` — declare an MCP server to Paddock itself (#691 step 6, the last of
the sequence).

```yaml
mcpServers:
  notion:
    command: npx
    args: ["-y", "@notionhq/notion-mcp-server"]
    env:
      NOTION_TOKEN: env:NOTION_TOKEN     # a reference, not the token
```

Until now there was nowhere to say this. `claude.mcpServers: host` borrows the
servers your machine already has, which is no help if you are running Paddock in
a container and want Notion in it — there is nothing on the host to borrow. So
this is a **sibling of `claude:`, not a key inside it**: that block asks *whose*
servers this instance uses, this one says what it should have regardless.

Every project's keeper gets every server declared here, and each one's
`mcp__<name>__*` pattern is added to that keeper's tool allow-list — without
which the server attaches and then has every call silently refused. The boot log
names each attached server.

**Precedence** is `claude.mcpServers: host` < `mcpServers:` < Paddock's own. A
name you declare beats the same name inherited from `~/.claude.json`, because
this file is a statement about *this instance* and that one is ambient machine
state. Paddock's own still win: `paddock` and `paddock_manage` are reserved
names, and a `playwright` of yours loses to the built-in browser server — with a
warning at boot rather than in silence.

**Keeping the token out of the file.** `paddock.config.yaml` is git-tracked and
the Config screen writes to it, so anywhere a string is expected — `command`, an
`args` entry, an `env` value, `url` — **`env:VAR_NAME` reads that value from the
environment**, the same indirection `managementApi` already uses for its client
tokens. An unset variable **drops that server** with a warning naming the
variable, rather than starting it without its credential. An inline value is
still allowed (an MCP `env` entry is often not a secret) but a credential-shaped
key, or a `url` with a query string, is warned about. Nothing Paddock logs or
serves ever contains a value from this block, and it is deliberately absent from
the Config screen and every API response.

**A declaration Paddock cannot carry faithfully is refused, not degraded** —
`headers:`, `type: sse`, an unrecognised key (`arg:` for `args:`), or both/neither
of `command` and `url`. That is the opposite of how `claude.mcpServers: host`
treats the same problems, deliberately: a host server was configured elsewhere
for something else, while this one you typed at Paddock and can fix. Only the
offending server is dropped; the rest attach and the instance boots.

Also fixes a gap in the previous release: the Config screen showed four of the
five `claude:` levers and not `claude.mcpServers`. It is now listed, read-only,
alongside its siblings.
