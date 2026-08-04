# Paddock

**Project-first launchpad for Claude Code** — server-hosted, persistent, resumable
sessions organized by project, in a web UI.

```sh
npx @edspencer/paddock
```

Then open <http://127.0.0.1:4000>.

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

If you already use Claude Code on this machine, your existing login is picked up
automatically and there is nothing to do.

## Options

```
  -p, --port <port>       HTTP/WS port (default 4000)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock)
  -v, --version           Print the version
  -h, --help              Show help
```

Your projects, chats and settings live in `~/.paddock` and persist between runs.

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
