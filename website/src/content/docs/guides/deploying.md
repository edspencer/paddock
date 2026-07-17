---
title: Deploying Paddock
description: The recommended way to run Paddock — on a low-power, always-on machine you can reach over HTTPS from anywhere.
---

You *can* run Paddock on your laptop (see [Getting started](/getting-started/)), but
that's not how it's meant to live. Paddock's whole point is **persistent, resumable
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
docker run -d --name paddock -p 4000:4000 \
  -e CLAUDE_CODE_OAUTH_TOKEN=…       `# or ANTHROPIC_API_KEY` \
  -e PADDOCK_DATA_DIR=/data \
  -v paddock-data:/data \
  --restart unless-stopped \
  ghcr.io/edspencer/paddock:latest
```

`--restart unless-stopped` matters here — it's what makes Paddock come back after a
reboot or power blip, which is the whole point of an always-on host. A
docker-compose file (see [Getting started](/getting-started/)) is the tidy way to
keep the config in version control.

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

- [Securing Paddock](/guides/securing/) — authentication in front of Paddock.
- [A home-lab setup](/guides/home-lab/) — a full always-on, composed deployment.
- [Environment variables](/configuration/environment/) — every `PADDOCK_*` setting.
