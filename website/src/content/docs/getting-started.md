---
title: Getting started
description: Run Paddock with Docker or from source, and connect a Claude token.
---

Paddock is a single process per data root + port. The fastest way to try it is the
published Docker image; you can also run it from source for development.

## Run with Docker

Run the published image, point it at a data volume, and give it a Claude token:

```bash
docker run -d --name paddock -p 127.0.0.1:4000:4000 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# Max plan (CLI runtime)` \
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
  scripting kit (`python3`, `uv`, `jq`, `rsync`). Reach for it when your keepers
  **build and run** apps, not just edit them.

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
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN} # or ANTHROPIC_API_KEY for the SDK runtime
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
Paddock has **no authentication of its own**. Run it behind a reverse proxy / auth
layer you trust — see [Authentication](/configuration/authentication/). It reads
credentials from the environment and from files the host provides; it never stores
secrets itself.
:::

## Claude authentication

Paddock passes your Claude credentials through to the keeper agents. Provide **one**:

- `CLAUDE_CODE_OAUTH_TOKEN` — Claude **Max plan** auth for the CLI runtime.
- `ANTHROPIC_API_KEY` — API-pricing auth for the SDK runtime.

The token is passed through the process environment; it is never written to disk by
Paddock.

## Run from source

You need **Node 22+** and the **`claude` CLI** on your `PATH`.

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

- [Concepts](/concepts/) — how projects, keeper agents, chats, and the sweeper fit together.
- [Environment variables](/configuration/environment/) — the complete `PADDOCK_*` reference.
- [Architecture](/architecture/overview/) — what's happening under the hood.
