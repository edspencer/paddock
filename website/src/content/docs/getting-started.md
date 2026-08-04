---
title: Getting started
description: Try Paddock in one command with npx, or run it with Docker or from source.
---

Paddock is a single process per data root + port. The fastest way to try it is
**`npx`** — nothing to install, nothing to clone. For an always-on instance on a server,
use the published Docker image; to hack on Paddock itself, run it from source.

## Try it with npx

If you have Node 22+, you can run Paddock against your **existing Claude Code history**
in one command. `cd` into a directory where you've been using Claude Code recently:

```bash
cd ~/code/some-project
npx @edspencer/paddock --here
```

Paddock opens **that directory** as its workspace, finds the Claude Code sessions you
already have for it, and offers them for import. Open **http://127.0.0.1:4000** (or add
`-o` to have it opened for you) — and instead of an empty instance, you're looking at
your own conversations, resumable.

Later runs in the same directory resume it, with no flag needed.

:::note[What `--here` writes into the directory]
The flag is the consent, so here is exactly what it does — all of it reversible, none of
it touching your code:

- creates **`.paddock/`** for this workspace's state
- creates **`.chats/`** for transcripts
- appends those two entries to **`.gitignore`**

**Your `~/.claude` is not touched.** Sessions found there are *offered* for import —
nothing is moved, copied or linked until you confirm, and the originals stay where they
are afterwards, so your terminal `claude` keeps working exactly as before.

To undo it completely: `rm -rf .paddock .chats` and drop the two `.gitignore` lines.
:::

Without `--here`, Paddock never touches the directory you ran it from — it starts a
normal instance in `~/.paddock` and you create projects from the UI.

**First run downloads ~250 MB.** Paddock drives Claude Code, and the Claude Agent SDK
ships a per-platform binary of that size. Later runs reuse the npm cache and start
immediately. If you expect to use it often, `npm i -g @edspencer/paddock` is friendlier
than bare `npx`.

Useful flags:

```
  -p, --port <port>       HTTP/WS port (default 4000)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock)
      --here              Open the CURRENT directory as the workspace
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
```

Credentials work the same as everywhere else — see
[Claude authentication](#claude-authentication) below. If you already use Claude Code on
this machine, your existing login is picked up automatically and there is nothing to do.

An npx run binds **loopback with authentication disabled**, which is the right default
for a laptop, and it *fails closed*: bind a routable address without configuring auth and
it refuses to start. See [Binding & network exposure](/configuration/binding-and-exposure/).

## Run with Docker

For an always-on instance on a server, the published image is the simplest route. Point
it at a data volume and give it a Claude token:

```bash
docker run -d --name paddock -p 127.0.0.1:4000:4000 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# Max plan auth (or ANTHROPIC_API_KEY)` \
  -e PADDOCK_DATA_DIR=/data \
  -e PADDOCK_DANGEROUSLY_ALLOW_OPEN=1 `# required in a container — see below` \
  -v paddock-data:/data \
  ghcr.io/edspencer/paddock:latest
```

Then open **http://localhost:4000** and click **New Project**.

:::caution[Both of those flags are load-bearing — without the first, Paddock won't start]
**`PADDOCK_DANGEROUSLY_ALLOW_OPEN=1` is required for *any* container run.** Inside a
container the app always binds `0.0.0.0`, because Docker's port publishing can't route
to an in-container `127.0.0.1`. Paddock's fail-closed
[bind guard](/configuration/binding-and-exposure/) sees a non-loopback bind under the
default `PADDOCK_AUTH_MODE=none` and **refuses to boot** — the container exits straight
away with `refusing to start: bind host "0.0.0.0" is not loopback…`. The flag downgrades
that refusal to a boot warning.

**`-p 127.0.0.1:4000:4000`** is what actually keeps you safe, and it's why the flag
above is acceptable here. It publishes to the host's loopback only, so the real boundary
is the container's network namespace plus this publish — not the in-container bind.
Publishing on a routable address (`-p 4000:4000`) with no auth mode hands an
unauthenticated, code-executing Paddock to your whole network.

To reach it from another machine, keep the loopback publish and put a reverse proxy in
front — see [Securing Paddock](/guides/securing/).
:::

### Two image flavors: base vs devbox

Paddock publishes **two official images** from the same source — pick the tag that
matches what your agents do:

- **`ghcr.io/edspencer/paddock:latest`** — the **base** image (used above). The lean
  runtime: the Paddock app plus `git`, `openssh-client`, `gh`, and the `claude` CLI.
  Everything a stock instance needs to read, write, and reason over code.
- **`ghcr.io/edspencer/paddock:devbox`** — the **devbox** image. Base *plus* the
  coding-agent toolbox: `pm`/PM2 preview servers, `ffmpeg`, a headless Playwright MCP
  browser, the Docker CLI (with the `buildx` and `compose` plugins), `kubectl`, and a
  scripting kit (`python3`, `uv`, `jq`, `rsync`). Reach for it when Claude needs
  to **build and run** apps, not just edit them.

The devbox only adds tools — same app, same `/data` layout — so you can swap tags
against the same volume. It's a much bigger image (the Chromium layer alone is ~1 GB),
so stay on base unless you need those tools.
[The Dev Box flavor](/guides/dev-box-flavor/) is the canonical breakdown of what each
image carries, and why each tool is in the image it's in.

### docker-compose

```yaml
services:
  paddock:
    image: ghcr.io/edspencer/paddock:latest
    ports:
      # Loopback only. Do NOT use "4000:4000" without an auth mode in front.
      - "127.0.0.1:4000:4000"
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN} # or ANTHROPIC_API_KEY for API pricing
      PADDOCK_DATA_DIR: /data
      # Required in a container — see the caution above.
      PADDOCK_DANGEROUSLY_ALLOW_OPEN: "1"
    volumes:
      - paddock-data:/data
volumes:
  paddock-data:
```

:::tip[Ready-made deploy recipes]
For a maintained starting point, the
[**`paddock-deploy`**](https://github.com/edspencer/paddock-deploy) repo collects
self-hosting recipes you can copy: a base + devbox
[`docker/`](https://github.com/edspencer/paddock-deploy/tree/main/docker)
compose stack, `proxmox-iac/` (Tofu + Ansible), `kubernetes/` (Kustomize), and an
`auth-basic/` Caddy sidecar for a quick login gate. See
[Deploying Paddock](/guides/deploying/) for the recommended setup.
:::

:::caution[No built-in login]
Paddock has **no authentication of its own**. Anywhere it is reachable by more than your
own machine — a server, a container published on a routable address — run it behind a
reverse proxy / auth layer you trust; see
[Authentication](/configuration/authentication/). It reads credentials from the
environment and from files the host provides; it never stores secrets itself.

This is not a concern for a local `npx` run, which binds loopback only.
:::

## Claude authentication

Paddock passes your Claude credentials through to the agents. Provide **one**:

- `CLAUDE_CODE_OAUTH_TOKEN` — Claude **Max plan** auth.
- `ANTHROPIC_API_KEY` — **API-pricing** auth.

Either works on either runtime — the choice of credential is independent of how a
turn is driven.

The token is passed through the process environment; it is never written to disk by
Paddock.

## Run from source

You need **Node 22+**. Chats resolve the Claude Agent SDK's own bundled binary and never
consult `PATH`, so they work without anything else installed; the **`claude` CLI** on
your `PATH` is needed only for the post-turn sweeper and for triggers.

```bash
git clone https://github.com/edspencer/paddock.git
cd paddock
npm install
```

### Production-like (one process serves API + WS + SPA)

This is how the deployed service runs — the server serves the built SPA and exposes
`/api` + `/ws` on the same origin.

```bash
# Load your Claude token into the environment (never echo it).
export CLAUDE_CODE_OAUTH_TOKEN=…

npm run build                 # build web dist + server dist
export PADDOCK_DATA_DIR="$(mktemp -d /tmp/paddock-dev.XXXXXX)"   # optional throwaway data dir
npm run start                 # node packages/server/dist/index.js
```

Open **http://localhost:4000/**. Quick checks:

```bash
curl -s http://localhost:4000/api/health     # {"ok":true}
curl -s http://localhost:4000/api/projects    # {"projects":[...]}
```

### Hot-reload dev (two processes)

For frontend iteration — Vite serves the SPA on `:5173` and proxies `/api` + `/ws`
to the backend on `:4000`:

```bash
npm run dev        # terminal 1 — backend (watched) on :4000
npm run dev:web    # terminal 2 — Vite SPA on :5173
```

See the repo's [DEV.md](https://github.com/edspencer/paddock/blob/main/DEV.md) for
the full local-development guide.

## Next steps

- [Concepts](/concepts/) — how projects, agents, chats, and the sweeper fit together.
- [Environment variables](/configuration/environment/) — the complete `PADDOCK_*` reference.
- [Architecture](/architecture/overview/) — what's happening under the hood.
