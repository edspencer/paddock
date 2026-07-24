---
title: The Dev Box flavor
description: The devbox image — what it adds over the base image, when to want it, and how to run preview servers, a browser, ffmpeg, and Docker in-container.
---

Paddock ships as **two official images** built from the same source. Pick the one
that matches what your agents actually do:

- **`ghcr.io/edspencer/paddock:latest`** — the **base** image. The lean runtime:
  the Paddock app plus `git`, `gh`, and the `claude` CLI. Everything a stock
  instance needs to read, write, and reason over text and code — and nothing more.
- **`ghcr.io/edspencer/paddock:devbox`** — the **devbox** image. Base *plus* the
  software-engineering toolbox a coding agent reaches for: `pm` preview servers,
  `ffmpeg`, a headless browser, and the Docker CLI.

The devbox only adds **tools**. It's the same app, the same data layout, the same
`/data` volume — so you can stop one profile and start the other against the same
data without losing anything. Reach for devbox when your keepers **build and run**
apps, not just edit them.

:::note[The devbox is a big image]
The Playwright Chromium layer alone is roughly a gigabyte. If your agents never
need a browser, preview server, media work, or Docker, stay on **base** — it's
much smaller and everything else is identical.
:::

## What devbox adds, and why an agent wants each

### `pm` — preview servers on stable ports (PM2)

When an agent builds a web app, it needs to actually run it and look at it. `pm`
is a thin wrapper over [PM2](https://pm2.keymetrics.io/) plus a small shared ports
registry. It lets an agent (or you) run long-running dev/preview servers on
**stable, assigned ports**, with the running state visible to **every** chat
session — PM2's daemon and the ports registry are a single shared source of truth
that all callers read. The devbox installs `pm` to `/usr/local/bin/pm` and PM2
globally, so the workflow is turnkey. [Using `pm`](#using-pm) below has the details.

### `ffmpeg` — media work

Transcoding, extracting frames, trimming audio, building a demo GIF — anything
media-shaped. Agents doing podcast, video, or screenshot-to-clip work need
`ffmpeg` on `PATH`; base doesn't carry it.

### The Playwright MCP browser — a real headless Chromium

The devbox bundles the [Playwright MCP](https://github.com/microsoft/playwright-mcp)
server and a matching **headless Chromium**, so an agent can drive a real browser:
navigate, click, fill forms, and take screenshots — for example, to QA the very
preview server it just started with `pm`.

This is **on by default** in devbox: the image sets `PADDOCK_BROWSER_MCP=1`, which
tells Paddock to attach the browser MCP tools to keepers at launch. (On base, the
browser tools simply aren't present.) The browser runs headless and sandboxed by
the container — Paddock launches it `--no-sandbox --isolated`, because the
container itself is the sandbox.

:::tip[Turning it off]
The browser is the heaviest thing in the image and the tools add up in an agent's
context. If you want the other devbox tools but not the browser, set
`PADDOCK_BROWSER_MCP=0` in your run config.
:::

### The Docker CLI — build and run containers in-container

Some agent work is itself Docker-shaped: building an image, running a throwaway
container, testing a Compose stack. The devbox ships the Docker **client** (`docker`
on `PATH`) — but **no daemon and no privilege baked in**. Whether that CLI can
actually reach a daemon is a deployment decision; see
[Docker-in-Docker](#docker-in-docker) below.

## Running the devbox image

It runs exactly like base — same volume, same auth, same port — just a different
tag:

```bash
docker run -d --name paddock -p 127.0.0.1:4000:4000 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# or ANTHROPIC_API_KEY` \
  -e PADDOCK_DANGEROUSLY_ALLOW_OPEN=1 `# containers always bind 0.0.0.0` \
  -v paddock-data:/data \
  --restart unless-stopped \
  ghcr.io/edspencer/paddock:devbox
```

- **`/data`** is the one thing you must persist. Everything Paddock keeps —
  projects, chat transcripts, and its sidecar state — lives there, and `HOME=/data`
  so `~/.claude/projects` (session transcripts) survives restarts, which is what
  makes resume work. Use a named volume or a real disk you back up.
- **Claude auth** comes in at run time, never baked into the image: set
  `CLAUDE_CODE_OAUTH_TOKEN` for Claude Max/Pro (the `cli` runtime), or
  `ANTHROPIC_API_KEY` to use the API (the `sdk` runtime). Get an OAuth token with
  `claude setup-token` on a machine where you're already logged in.
- **`PADDOCK_DANGEROUSLY_ALLOW_OPEN=1`** is required for *any* containerized
  Paddock, base or devbox: inside a container the app always binds `0.0.0.0`
  (Docker's port publishing can't route to an in-container `127.0.0.1`), and
  Paddock's fail-closed guard would otherwise refuse to boot. This is safe **only**
  because the `-p 127.0.0.1:4000:4000` publish keeps the instance host-only. If you
  ever publish on a routable address, drop this flag and put a real auth mode in
  front — see [Securing Paddock](/guides/securing/).

:::tip[Use the recipe]
Don't hand-roll the flags. The **[`docker/` recipe in `paddock-deploy`](https://github.com/edspencer/paddock-deploy/tree/main/docker)**
is a ready-made Compose file with `base` and `devbox` profiles, loopback-only
publishing, a healthcheck, and the docker-outside-of-docker socket mount wired up.
Copy it, drop your token into `.env`, and `docker compose --profile devbox up -d`.
:::

## Using `pm`

`pm` gives each named project a **stable port** (default range `5001–5999`) and
injects `PORT` and `HOST=0.0.0.0` into the process, so a framework that honours
those binds correctly without hard-coding a port.

```bash
# Start a dev server. --cwd is the code dir; everything after -- is the command.
pm start web --cwd /data/projects/my-app -- npm run dev

# See what's running (shared across every chat session):
pm status
# PROJECT   PORT   STATE    URL
# web       5001   online   http://localhost:5001

# Tail its logs (add --follow to stream):
pm logs web

pm stop web        # stop, but keep the assigned port reserved
pm restart web     # restart with a freshly-rebuilt env
```

:::caution[Your server must bind `0.0.0.0` and read `$PORT`]
`pm` doesn't proxy — it just runs your command with `PORT` and `HOST` set. The dev
server has to honour them: bind `0.0.0.0` (not `localhost`) so the port is
reachable, and read the port from `$PORT` rather than hard-coding one. Most
frameworks do this out of the box (`next dev`, Vite, etc.); if `-- npm run dev`
ignores `$PORT`, pass the port through explicitly (e.g. `next dev -p $PORT`).
:::

### Configuring the URLs

By default `pm status` prints `http://localhost:<port>`. A few knobs (resolved as
**real env var → config file → default**) tune that; the two you're most likely to
touch:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PM_PUBLIC_HOST` | `localhost` | Host shown in the printed preview URLs. Set it to the hostname your instance is actually reachable at, so the URLs are clickable. |
| `PM_PORT_MIN` / `PM_PORT_MAX` | `5001` / `5999` | The port-assignment range. If you publish preview ports through a proxy, this is the range to route. |

Set them as environment on the container, or in the `pm` config file
(`/etc/paddock-servers/pm.env` by default). The full set — including the ports
registry path and the dev-server data-isolation knobs — is in
[`scripts/README.md`](https://github.com/edspencer/paddock/blob/main/scripts/README.md)
in the Paddock repo.

:::note[Preview ports are separate from Paddock's port]
Only Paddock's own port (`4000`) is published by the run command above. To reach a
`pm` preview server from another machine, you also have to expose its port — front
it with the same reverse proxy that fronts Paddock, or route the `PM_PORT_MIN..MAX`
range. Like Paddock itself, a preview server is unauthenticated: don't expose one
with secrets or private data on it.
:::

## Docker-in-Docker

The devbox ships the Docker **CLI only** — no daemon runs in the container, and no
privilege is baked into the image. That's deliberate: *how* the CLI reaches a
daemon is a security trade-off the deployment recipe makes, not the image.

There are two common shapes, and the
[`docker/` recipe](https://github.com/edspencer/paddock-deploy/tree/main/docker)
documents both:

- **Docker-outside-of-Docker (socket mount)** — mount the host's
  `/var/run/docker.sock` into the container, so an in-container `docker build/run`
  lands on the **host** daemon. Cheap, no nested daemon — but it gives the container
  effectively root-level control of the host through that socket, so only do it for
  keepers you trust.
- **Privileged Docker-in-Docker** — run a real, isolated daemon *inside* the
  container. It never touches the host daemon, but `privileged: true` weakens the
  container boundary and you run and maintain a second daemon plus its storage.
  Prefer the socket mount unless you specifically need daemon isolation.

The recipe's Compose file wires up the socket mount by default and shows how to
switch to privileged DinD.

## Next

- [The `docker/` recipe](https://github.com/edspencer/paddock-deploy/tree/main/docker) — the Compose file with `base` and `devbox` profiles.
- [Deploying Paddock](/guides/deploying/) — where and how to run an always-on instance.
- [Securing Paddock](/guides/securing/) — authentication in front of Paddock (required before anyone but you can reach it).
- [A home-lab setup](/guides/home-lab/) — a full always-on, composed deployment.
