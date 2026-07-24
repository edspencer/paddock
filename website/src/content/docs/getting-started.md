---
title: Getting started
description: Run Paddock with Docker or from source, and connect a Claude token.
---

Paddock is a single process per data root + port. The fastest way to try it is the
published Docker image; you can also run it from source for development.

## Run with Docker

Run the published image, point it at a data volume, and give it a Claude token:

```bash
docker run -d --name paddock -p 4000:4000 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# Max plan (CLI runtime)` \
  -e PADDOCK_DATA_DIR=/data \
  -v paddock-data:/data \
  ghcr.io/edspencer/paddock:latest
```

Then open **http://localhost:4000** and click **New Project**.

### Two image flavors: base vs devbox

Paddock publishes **two official images** from the same source — pick the tag that
matches what your agents do:

- **`ghcr.io/edspencer/paddock:latest`** — the **base** image (used above). The lean
  runtime: the Paddock app plus `git`, `gh`, and the `claude` CLI. Everything a stock
  instance needs to read, write, and reason over code.
- **`ghcr.io/edspencer/paddock:devbox`** — the **devbox** image. Base *plus* the
  coding-agent toolbox: `pm`/PM2 preview servers, `ffmpeg`, a headless Playwright MCP
  browser, and the Docker CLI. Reach for it when your keepers **build and run** apps,
  not just edit them.

The devbox only adds tools — same app, same `/data` layout — so you can swap tags
against the same volume. It's a much bigger image (the Chromium layer alone is ~1 GB),
so stay on base unless you need those tools. See
[The Dev Box flavor](/guides/dev-box-flavor/) for the full breakdown.

### docker-compose

```yaml
services:
  paddock:
    image: ghcr.io/edspencer/paddock:latest
    ports:
      - "4000:4000"
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN} # or ANTHROPIC_API_KEY for the SDK runtime
      PADDOCK_DATA_DIR: /data
    volumes:
      - paddock-data:/data
volumes:
  paddock-data:
```

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
