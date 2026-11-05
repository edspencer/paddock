---
title: Deploying Paddock
description: The recommended way to run Paddock — on a low-power, always-on machine you can reach over HTTPS from anywhere.
---

You *can* run Paddock on your laptop — `npx @edspencer/paddock` is one command
and the fastest way to try it (see
[Getting started](/getting-started/#try-it-with-npx)) — but that's not how it's meant
to live. Paddock's whole point is **persistent, resumable
agents you can reach from anywhere** — and a laptop that sleeps, closes, and moves
around defeats that.

:::tip[The recommended setup]
Run Paddock on a machine that is **always on**, **draws very little power**, and is
**reachable over HTTP/HTTPS** from wherever you need it. Then its agents are always
available — from your desk, your phone, or the other side of the world.
:::

## Pick an always-on host

It does **not** have to be fancy. Anything that stays on and sips power works:

- A **mini PC** (Intel N100-class), an **Intel NUC**, or an old thin client.
- A **Raspberry Pi 4/5** (Paddock's image is multi-arch — `arm64` and `amd64`).
- A **NAS** that runs Docker (Synology, etc.).
- An **LXC container or VM** on a home server (Proxmox, etc.) — this is what the
  author uses; see [A home-lab setup](/guides/home-lab/).
- A small **cloud VPS**, if you'd rather not host at home.

The common thread: on 24/7, low idle power, and something you (and only you) can
reach on the network.

## Run it

Paddock ships as a Docker image, which is the simplest way to deploy on any of the
hosts above:

```bash
docker run -d --name paddock -p 127.0.0.1:7233:7233 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# or ANTHROPIC_API_KEY` \
  -e PADDOCK_DATA_DIR=/data \
  -e PADDOCK_DANGEROUSLY_ALLOW_OPEN=1 `# every container run needs this` \
  -v paddock-data:/data \
  --restart unless-stopped \
  ghcr.io/edspencer/paddock:latest
```

`PADDOCK_DANGEROUSLY_ALLOW_OPEN=1` is not optional here: in a container the app binds
`0.0.0.0`, and the fail-closed
[bind guard](/configuration/binding-and-exposure/#containers-are-different) **refuses to
boot** on a non-loopback bind under the default `PADDOCK_AUTH_MODE=none`. It is safe in
this command only because the publish is `127.0.0.1`-bound — the container namespace
plus that publish is the real boundary. Publish on a routable address instead and you
should drop this flag and set a real auth mode; see
[Securing Paddock](/guides/securing/).

`--restart unless-stopped` matters here — it's what makes Paddock come back after a
reboot or power blip, which is the whole point of an always-on host. A
docker-compose file (see [Getting started](/getting-started/)) is the tidy way to
keep the config in version control.

Two image tags are published from the same source: **`:latest`** (base — the app plus
`git`/`openssh-client`/`gh`/`claude`) and **`:devbox`** (base plus the coding-agent
toolbox — `pm`, `ffmpeg`, a headless browser, the Docker CLI, `kubectl`, and a
scripting kit — for projects that build and run apps).
[The Dev Box flavor](/guides/dev-box-flavor/) is the full, current breakdown of what
each image carries.

:::tip[Don't hand-roll it — use a recipe]
The **[`edspencer/paddock-deploy`](https://github.com/edspencer/paddock-deploy)** repo
holds ready-made, copy-and-go deployment recipes so you don't have to assemble the
flags yourself:

- **[`docker/`](https://github.com/edspencer/paddock-deploy/tree/main/docker)** — a
  Compose file with `base` and `devbox` profiles, loopback-only publishing, a
  healthcheck, and the Docker socket mount wired up.
- **[`proxmox-iac/`](https://github.com/edspencer/paddock-deploy/tree/main/proxmox-iac)** —
  OpenTofu + Ansible to provision an LXC and run Paddock as a tarball+systemd service
  (see [Running Paddock on Proxmox (LXC)](/guides/proxmox-lxc/)).
- **[`kubernetes/`](https://github.com/edspencer/paddock-deploy/tree/main/kubernetes)** —
  Kustomize manifests for a single-writer deployment
  (see [Running Paddock on Kubernetes](/guides/kubernetes/)).
- **[`auth-basic/`](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic)** —
  a Caddy/nginx Basic-Auth-over-TLS sidecar to put a quick gate in front.

Copy the one you want, drop your token into `.env`, and bring it up.
:::

### Data & backups

Everything Paddock persists lives under `PADDOCK_DATA_DIR` — projects, chat
transcripts, and its sidecar state. Put it on a **named volume or a real disk you
back up.** The data directory is git-friendly (projects are directories); a periodic
snapshot or offsite copy is enough to recover.

### One process per port

Paddock is **one process per data root + port.** To run several (say, one for work
and one for home), start one container each with its own `PADDOCK_DATA_DIR` and
`PORT`, and front them with a reverse proxy that maps a hostname to each. Nothing is
shared between instances except the host.

### Keeping it current

New releases are published to `ghcr.io/edspencer/paddock`. Re-pull and recreate the
container to update, or automate it — a tool like Watchtower, or a small "watch for a
new release and redeploy" job, keeps you on the latest without manual work. (The
author's setup auto-deploys new tagged releases; see
[A home-lab setup](/guides/home-lab/).)

`paddock` is on `PATH` in the image, so you can ask the container what it would do:

```bash
docker exec paddock paddock update --check
```

```
Paddock 0.82.0 is available (you have 0.81.0).
  Run: docker compose pull && docker compose up -d    (image ghcr.io/edspencer/paddock:0.82.0)
```

Nothing installs anything *inside* a container — the image sets `PADDOCK_IN_DOCKER=1`, so
`paddock update` there prints the pull command and exits 5. See
[Updating Paddock](/guides/updating/) for the rest.

#### Don't restart it mid-turn

An automatic updater will, sooner or later, recreate the container while a chat turn is in
flight. A turn is a live `claude` subprocess writing a transcript; it cannot be resumed
from where it was interrupted, so that turn is simply lost — and the person who asked for
it finds a half-finished answer with no explanation.

`paddock busy` is there for exactly this. It exits **0** when nothing would be lost, **75**
when something would, and **3** when nothing is running — and 75 is `EX_TEMPFAIL`, which is
the code Watchtower's pre-update hook reads as *"skip this one"*. Turn lifecycle hooks on
and label the container:

```yaml
services:
  paddock:
    image: ghcr.io/edspencer/paddock:latest
    labels:
      com.centurylinklabs.watchtower.lifecycle.pre-update: "paddock busy"
  watchtower:
    image: containrrr/watchtower
    environment:
      WATCHTOWER_LIFECYCLE_HOOKS: "true"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Watchtower runs the hook inside the container before it stops it; a non-zero exit skips
the update and it tries again on its next pass. Without
`WATCHTOWER_LIFECYCLE_HOOKS=true` the label is read and the hook is never run, which looks
exactly like a hook that always says yes.

An Ansible task or a deploy job does the same thing with a retry:

```yaml
- name: wait for Paddock to be idle
  command: docker exec paddock paddock busy
  register: idle
  until: idle.rc == 0
  retries: 30
  delay: 60
  changed_when: false
```

If something other than Watchtower owns the upgrade, set `PADDOCK_UPDATE_HINT` to the
command that performs it; `paddock update` then prints that sentence instead of guessing at
a `docker compose` line.

## Making it reachable — safely

Bind Paddock to the host and reach it through a **reverse proxy that terminates TLS**
(Caddy, nginx, Traefik…), so you get `https://paddock.example.com` instead of a raw
port. Two ways to reach it from outside your home:

- **Keep it private (recommended for most people).** Don't expose it to the internet
  at all — reach it over a **VPN or an overlay network** (WireGuard, Tailscale,
  etc.). Simple and very safe.
- **Expose it through the proxy** — only if the proxy **authenticates every request**
  (see below).

:::danger[Do not skip this]
Paddock has **no login of its own.** Anyone who can reach it can drive your
agents — which run commands, hold your tokens, and can touch your repositories.
**Never** put Paddock directly on a public interface. Read
[Securing Paddock](/guides/securing/) before anyone but you can reach it — this is
not optional, even on your home network.
:::

## Next

- [`paddock-deploy`](https://github.com/edspencer/paddock-deploy) — copy-and-go recipes for Docker, Proxmox, Kubernetes, and a Basic-Auth sidecar.
- [Securing Paddock](/guides/securing/) — authentication in front of Paddock.
- [A home-lab setup](/guides/home-lab/) — a full always-on, composed deployment.
- [Environment variables](/configuration/environment/) — every `PADDOCK_*` setting.
