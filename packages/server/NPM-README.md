# Paddock

**Project-first launchpad for Claude Code** — server-hosted, persistent, resumable
sessions organized by project, in a web UI.

```sh
npx @edspencer/paddock
```

Then open <http://127.0.0.1:7233>.

Or point it at work you've already done — see [Open your own project](#open-your-own-project).

> **First run downloads ~250 MB.** Paddock drives Claude Code, and the Claude
> Agent SDK ships a per-platform binary of that size. It cannot be skipped —
> installing with `--omit=optional` produces a Paddock whose chats all fail.
> Later runs reuse the npm cache and start immediately. For repeated use,
> `npm i -g @edspencer/paddock` is friendlier than bare `npx`.

## Credentials

Paddock runs Claude Code on your behalf, so it needs Claude credentials:

```sh
claude setup-token                  # Claude Max/Pro
export ANTHROPIC_API_KEY=sk-ant-…   # or API billing
```

**If you already use Claude Code on this machine, there is nothing to do.** Paddock
keeps a Claude home of its own under the data dir, but not a login of its own: it uses
the one you already have — the macOS Keychain entry on a Mac, your
`~/.claude/.credentials.json` elsewhere (symlinked in, never copied). Reading a login
writes nothing, and nothing else is shared with it.

To give Paddock its own instead, set `claude: { credentials: own }` in
`<data-dir>/paddock.config.yaml`; a login is then a token in the environment as above,
or a one-off `CLAUDE_CONFIG_DIR=<data-dir>/claude-home claude login`. Either way,
Paddock says at startup if it can find no credentials at all.

## What else Paddock does and does not take from your `~/.claude`

Apart from that login: **nothing, by default.** Your `CLAUDE.md`, `agents/`,
`commands/` and `plugins/` are not loaded, the hooks your `settings.json` binds to tool
use do not run, your transcripts are not touched, and your `~/.claude.json` MCP servers
are not attached. Each is one key in `<data-dir>/paddock.config.yaml`:

```yaml
claude:
  transcripts: host    # own | host, default own — whose session transcripts
  credentials: host    # own | host, default host — the one shared by default
  instructions: host   # own | host, default own — CLAUDE.md, agents, commands, plugins
  hooks: host          # own | host, default own — shell commands settings.json binds
  mcpServers: host     # own | host, default own — the servers in your ~/.claude.json
```

`instructions: own` is worth knowing about if you have curated a `~/.claude/CLAUDE.md`:
your Paddock agents will not see it until you set `host`. Each project's own `CLAUDE.md`
always applies. `hooks` is off by default because inheriting someone's shell commands is
not a thing to discover after the fact; the rest of your `settings.json` — permissions,
model, statusline — applies either way.

To give this instance an MCP server your machine does not have — the case `host`
cannot serve — declare it in a **sibling** `mcpServers:` block of the same file, using
`env:VAR_NAME` anywhere a string goes so the token stays out of the git-tracked file
(keep `driveMode` on its default `session` for a server holding a credential — `batch`
passes the definition to `claude` as a command-line argument, where any local user can
read it):

```yaml
mcpServers:
  notion:
    command: npx
    args: ["-y", "@notionhq/notion-mcp-server"]
    env:
      NOTION_TOKEN: env:NOTION_TOKEN
```

## Open your own projects

A brand-new instance is empty, so it opens on **Discover**. That reads your Claude
Code history, works out which directories on this machine you have actually been
using `claude` in, and offers them as projects — with conversation counts, last-used
dates and git remotes, so you can tell them apart.

Tick the ones you want and press Import. Each becomes a project pointing at that
directory, with its conversations copied in as chats you can resume — so instead of
an empty instance you are looking at your own work. Expand a row first if you would
rather pick individual conversations than take the lot. Discover stays in the sidebar
afterwards; it is not only a first-run screen.

**Nothing is written into the directories you import.** No `.paddock/`, no `.chats/`,
no `.gitignore` edit, no `CLAUDE.md`. The project record and the copied transcripts
both live in the data dir, and the project simply points at the path.

**Your `~/.claude` is not touched either.** Transcripts are *copied*, with their
timestamps preserved — the originals are never moved or deleted, and your terminal
`claude` keeps working exactly as before. To share **one** set of transcripts between
Paddock and your terminal rather than keeping a copy, set
`claude: { transcripts: host }` in `<data-dir>/paddock.config.yaml`. (Your *login* is
already shared, which is why there is nothing to log into — see Credentials above.)

## Options

```
  -p, --port <port>       HTTP/WS port (default 7233)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock)
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the version
  -h, --help              Show help
```

Your projects, chats and settings persist between runs in `~/.paddock`, or wherever
`--data-dir` points. It is one directory: move it to move your instance, delete it to
start over. Where you run `paddock` from has no effect on which instance you get.

## Security

Paddock binds **loopback only** with authentication disabled, which is the right
default for a laptop. It **refuses to start** if you bind a routable interface
while auth is off — to expose it on a network, configure `PADDOCK_AUTH_MODE`
first. See [AUTH.md](https://github.com/edspencer/paddock/blob/main/AUTH.md).

## Requirements

Node.js 22 or newer.

## Other ways to run it

A multi-arch Docker image is published alongside this package, and is the better
fit for a server deployment:

```sh
docker run -d -p 127.0.0.1:7233:7233 -v /srv/paddock-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  -e PADDOCK_DANGEROUSLY_ALLOW_OPEN=1 \
  ghcr.io/edspencer/paddock:latest
```

`PADDOCK_DANGEROUSLY_ALLOW_OPEN=1` is required: the image binds `0.0.0.0` and the
default auth mode is `none`, and Paddock refuses to bind a routable interface
unauthenticated unless told to. Publishing on `127.0.0.1:` is what makes that
safe — Paddock runs code and spends Claude tokens, so put an auth mode or a
reverse proxy in front of it before exposing the port to a network.

## Links

- [Documentation](https://github.com/edspencer/paddock#readme)
- [Issues](https://github.com/edspencer/paddock/issues)
- Built on [herdctl](https://github.com/edspencer/herdctl)

MIT © Ed Spencer
