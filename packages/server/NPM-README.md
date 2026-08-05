# Paddock

**Project-first launchpad for Claude Code** — server-hosted, persistent, resumable
sessions organized by project, in a web UI.

```sh
npx @edspencer/paddock
```

Then open <http://127.0.0.1:4000>.

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
`commands/` and `plugins/` are not loaded, and the hooks your `settings.json` binds to
tool use do not run. Both are one key in `<data-dir>/paddock.config.yaml`:

```yaml
claude:
  instructions: host   # own | host, default own — CLAUDE.md, agents, commands, plugins
  hooks: host          # own | host, default own — shell commands settings.json binds
```

`instructions: own` is worth knowing about if you have curated a `~/.claude/CLAUDE.md`:
your Paddock agents will not see it until you set `host`. Each project's own `CLAUDE.md`
always applies. `hooks` is off by default because inheriting someone's shell commands is
not a thing to discover after the fact; the rest of your `settings.json` — permissions,
model, statusline — applies either way.

## Open your own project

```sh
cd ~/code/some-project        # somewhere you've used Claude Code
npx @edspencer/paddock --here
```

`--here` opens **that directory** as Paddock's workspace: Claude works in your files,
and any Claude Code sessions you already have for the directory are offered for
import. It's the fastest way to see what Paddock does with real history instead of an
empty instance. Later runs in the same directory resume it — no flag needed.

The flag is the consent, so here is everything it does:

- creates **`.paddock/`** for the workspace's state and **`.chats/`** for transcripts
- appends those two entries to **`.gitignore`**

**Nothing is written into your `~/.claude`** — no file, no symlink. Paddock uses a
Claude home of its own under `.paddock/` and relocates transcripts into `.chats/`.
Sessions found in `~/.claude` are *offered* for import: nothing is moved, copied or
linked until you confirm, and your terminal `claude` keeps working exactly as before.
To share one set of transcripts between Paddock and your terminal instead, set
`claude: { transcripts: host }` in `<data-dir>/paddock.config.yaml`. (Your *login* is
already shared, which is why there is nothing to log into — see Credentials above.)

To undo it: `rm -rf .paddock .chats` and drop the two `.gitignore` lines.

Without `--here`, Paddock never touches the directory you ran it from.

## Options

```
  -p, --port <port>       HTTP/WS port (default 4000)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock)
      --here              Open the CURRENT directory as the workspace
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the version
  -h, --help              Show help
```

Your projects, chats and settings persist between runs in `~/.paddock` — or in
`<dir>/.paddock` when you use `--here`. Either way it's one directory: move it to
move your instance, delete it to start over.

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
docker run -d -p 4000:4000 -v /srv/paddock-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=… ghcr.io/edspencer/paddock:latest
```

## Links

- [Documentation](https://github.com/edspencer/paddock#readme)
- [Issues](https://github.com/edspencer/paddock/issues)
- Built on [herdctl](https://github.com/edspencer/herdctl)

MIT © Ed Spencer
