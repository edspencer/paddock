---
title: Running Paddock on Proxmox (LXC)
description: Stand up Paddock in an unprivileged Debian LXC on Proxmox — two deploy paths (Docker inside the container, or a tarball + systemd via infra-as-code), both behind auth at the edge.
---

Proxmox is a great home for an always-on Paddock: a dedicated, unprivileged **LXC
container** is cheap, isolated, and boots with the node. This guide is the bridge
between the generic [Deploying Paddock](/guides/deploying/) walkthrough and the
[home-lab](/guides/home-lab/) narrative — it shows the **two concrete ways** to run
Paddock in an LXC, both backed by real recipes in the
[**`paddock-deploy`**](https://github.com/edspencer/paddock-deploy) repo.

- **[Path A — Docker inside the LXC](#path-a--docker-inside-the-lxc)** is the
  simplest: one `docker run` / Compose file, the tools baked into the image.
- **[Path B — tarball + systemd](#path-b--tarball--systemd-infra-as-code)** runs
  Paddock directly on the box with no Docker, provisioned as infrastructure-as-code
  (OpenTofu + Ansible).

Both end the same way: **behind a reverse proxy with authentication** — Paddock has
no login of its own. Don't skip [that step](#put-it-behind-auth).

## Step 1 — Create an unprivileged Debian LXC

Whichever path you pick, you first need a container. Use an **unprivileged** LXC with
a Debian template — it's the smaller blast radius, and it's what the recipes target.

### Via the Proxmox UI

**Create CT** → walk the wizard:

- **General:** untick nothing special; leave **Unprivileged container** *checked*.
- **Template:** a Debian image (e.g. `debian-12-standard`). Download one first with
  `pveam` if you haven't:

  ```bash
  pveam update
  pveam download local debian-12-standard_12.7-1_amd64.tar.zst
  ```

- **Disk / CPU / Memory:** a lean box is fine (2 cores / 2 GiB / 20 GiB). Size up if
  you'll run coding agents that build and test.
- **Network:** a bridge (`vmbr0`) with DHCP or a static CIDR.

### Via `pct` on the node

```bash
# Create an unprivileged Debian LXC (CTID and settings are placeholders)
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname paddock \
  --unprivileged 1 \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1
```

### Enable nesting + keyctl (needed for Docker / the devbox)

If you're taking **Path A** (Docker inside the LXC), or you want the **devbox** tools
(`pm`, headless Chromium, Docker CLI) inside an unprivileged container, the container
needs two extra features so containerised and keyring-using workloads work:

```bash
pct set 200 --features nesting=1,keyctl=1
```

You can also set these in the UI under **Options → Features**. A **lean base-only**
box that runs Paddock as a plain process doesn't need them.

:::note
`nesting=1,keyctl=1` is exactly what the `paddock-deploy` recipes turn on for their
**dev box** and leave off for the lean **home box** — see the
[`proxmox-iac/` README](https://github.com/edspencer/paddock-deploy/tree/main/proxmox-iac).
:::

### …or provision the LXC as code

You don't have to click through the wizard. The
[`proxmox-iac/`](https://github.com/edspencer/paddock-deploy/tree/main/proxmox-iac)
recipe provisions the container(s) with **OpenTofu** from a reusable LXC module —
`unprivileged`, `nesting`, `keyctl`, sizing, and network are all inputs. That's also
the front half of Path B below; if you're heading there, let Tofu create the container
rather than doing it by hand.

## Path A — Docker inside the LXC

The simplest way to run Paddock on Proxmox: install Docker **inside** the LXC and use
the standard Docker recipe unchanged. Nothing about it is Proxmox-specific once the
container has `nesting=1,keyctl=1` and Docker installed.

Inside the container, install Docker Engine + the Compose plugin, then follow the
[**`docker/`**](https://github.com/edspencer/paddock-deploy/tree/main/docker) recipe:

```bash
git clone https://github.com/edspencer/paddock-deploy
cd paddock-deploy/docker

cp .env.example .env
$EDITOR .env                              # paste your CLAUDE_CODE_OAUTH_TOKEN

docker compose --profile base   up -d     # app + git/gh/claude
# ...or the coding-agent toolbox image:
docker compose --profile devbox up -d     # + pm, ffmpeg, headless Chromium, docker CLI

curl -fsS http://127.0.0.1:4000/api/health   # -> {"ok":true}
```

The recipe publishes to **loopback only** (`127.0.0.1:4000`) — reachable from inside
the LXC, not from the LAN — which is the [safe posture](#the-bind-is-safe-by-default)
you want until auth is in front. Pick the **base** or **devbox** image with the
Compose profile; the split (and the docker-outside-of-docker socket mount for
in-container builds) is documented in the recipe's README.

:::tip
Path A is the concrete version of the `docker run` shown in
[Deploying Paddock](/guides/deploying/) — just running inside an LXC instead of on
bare metal. If you already know Docker, start here.
:::

## Path B — tarball + systemd (infra-as-code)

Prefer **no Docker on the box** — Paddock running directly under `systemd`, with the
`claude`/`gh`/tooling installed on the host? That's the
[**`proxmox-iac/`**](https://github.com/edspencer/paddock-deploy/tree/main/proxmox-iac)
recipe: **OpenTofu** provisions the LXC(s) and **Ansible** installs the tooling and
the Paddock service.

It ships two boxes from one reusable module, which mirrors the [home-lab](/guides/home-lab/)
shape:

- a **dev box** — `nesting=1,keyctl=1`, with Node, `gh`, `claude`, **plus** PM2,
  `ffmpeg`, headless Chromium, and Docker Engine (the full coding-agent toolbox);
- a lean **home box** — just Node, `gh`, and `claude`.

```bash
# 1. Provision the container(s) with Tofu
cd paddock-deploy/proxmox-iac/tofu
cp terraform.tfvars.example terraform.tfvars    # placeholders only — never commit
tofu init && tofu apply

# 2. Configure + deploy with Ansible
cd ../ansible
ansible-galaxy collection install -r requirements.yml
cp inventory/hosts.ini.example inventory/hosts.ini
ansible-playbook site.yml

# On the box, it answers on loopback:
curl -fsS http://127.0.0.1:3000/api/health
```

The default `paddock_deploy_method` is **`tarball`**: Ansible extracts a release
tarball to `/opt/paddock` and runs it with the host's Node under a `paddock.service`
unit, using the **host-installed** `claude`/`gh` (and, on the dev box, the rest of the
toolbox). The same recipe can flip to running the official **Docker image** under
systemd instead (`paddock_deploy_method=docker`) if you'd rather have the tools baked
in — so Path B can converge on Path A's image without changing hosts. Full inputs,
secrets handling, and the dev-vs-home split are in the recipe's README.

## Put it behind auth

Both paths leave Paddock bound to **loopback inside the container**, which is correct —
but useless from your phone, and dangerous the moment you widen the bind. **Do not**
expose the port directly.

:::danger[Paddock has no login of its own]
Anyone who can reach Paddock can drive your agents — they run commands, hold your API
and GitHub tokens, and can read and write your repositories. Put an **authentication
layer at the edge** before anything but the host can reach it. Read
[**Securing Paddock**](/guides/securing/) — this is not optional, even on your LAN.
:::

The [Securing Paddock](/guides/securing/) guide lays out the full ladder, from network
isolation (VPN / overlay) up to full SSO. For a Proxmox home box, two common shapes:

- **Quickest gate (Tier 1):** the
  [**`auth-basic/`**](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic)
  recipe stands up a Caddy or nginx **Basic Auth sidecar over TLS** in front of
  Paddock (running in `trusted-header` mode). One password, no SSO to run — fine for a
  solo user behind a quick gate.
- **Full SSO (Tier 3):** a reverse proxy delegating to a self-hosted IdP
  (Authentik/Authelia) with Paddock in `jwt` mode — the pattern the
  [home-lab](/guides/home-lab/) guide describes.

## The bind is safe by default

Paddock **fails closed**: it binds to `127.0.0.1` by default and *refuses to start*
if it's bound to a non-loopback address with authentication disabled. So a bare-metal
or tarball install (Path B) is closed until you deliberately open it.

Inside a **container**, the app always binds `0.0.0.0` — Docker's port publishing
can't route to an in-container `127.0.0.1`, so binding all interfaces is deliberate.
That trips the fail-closed guard, so the container recipes set
**`PADDOCK_DANGEROUSLY_ALLOW_OPEN=1`** to let the app boot. This does **not** expose
your instance: for a container the real boundary is the **network namespace plus the
loopback host-publish** (`127.0.0.1:4000`). If you ever publish on a routable address,
unset that flag and put a real auth mode in front instead. The `docker/` recipe README
explains this in full.

## Next

- [**`paddock-deploy`**](https://github.com/edspencer/paddock-deploy) — every recipe
  referenced here (`docker/`, `proxmox-iac/`, `auth-basic/`, `kubernetes/`).
- [Deploying Paddock](/guides/deploying/) — the general always-on deploy story.
- [A home-lab setup](/guides/home-lab/) — the full composed, as-code production shape.
- [Securing Paddock](/guides/securing/) — the authentication ladder.
- [Environment variables](/configuration/environment/) — every `PADDOCK_*` setting.
