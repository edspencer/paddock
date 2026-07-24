---
title: A home-lab setup
description: How the author runs Paddock in production — a dedicated always-on container, composed with the right tools, behind SSO, managed as code.
---

This is a walkthrough of how Paddock's author actually runs it. It's a **somewhat more
advanced** pattern than a single `docker run`, but the ideas transfer to any always-on
host. The point isn't the specific tools — it's the *shape*: **an isolated, always-on
environment, composed with exactly the tooling the agents need, behind real
authentication, managed as code.**

## The host: a dedicated, always-on container

Paddock runs in its **own LXC container on a Proxmox server** that's on 24/7 and draws
very little power. A dedicated container (rather than sharing a general box) means the
blast radius is contained: the agents can only touch what *that* container can touch.
A small VM, a mini PC, or a Pi would serve the same role — see
[Deploying Paddock](/guides/deploying/).

## Composition: give the agents their tools

The reason this setup is productive is **what lives alongside Paddock in that
container.** Paddock's keeper agents are Claude Code sessions, and they're only as
capable as the tools on the box. The author's container provisions:

- **Node.js and the `claude` CLI** on the `PATH` — keeper agents spawn `claude` per
  job, so the binary must be present (without it, jobs fail instantly with
  `spawn claude ENOENT`).
- **The `gh` GitHub CLI, authenticated with a scoped token** — so agents can open PRs
  and manage issues, but the token is a **fine-grained PAT limited to just the repos
  this instance should touch.** That scoping *is* the security boundary.
- **Media and utility binaries** like **`ffmpeg`** (and whatever a given workload
  needs) — so agents can actually do the work, not just talk about it.
- **A process manager (PM2)** backing Paddock's dev/preview servers, so agents can
  spin up a running app on a port you can open in a browser.

Swap in whatever your projects call for. The principle holds: **compose Paddock with
the tools that make your work real.**

:::tip[The modern shortcut: the devbox image]
This setup installs that toolbox onto the host by hand (via Ansible, below). The
**[devbox image](/guides/dev-box-flavor/)** (`ghcr.io/edspencer/paddock:devbox`) now
ships exactly this composition pre-baked — `pm`/PM2, `ffmpeg`, a headless Playwright
browser, and the Docker CLI on top of `git`/`gh`/`claude` — so you get the same capable
agents from a single image tag, no host provisioning required. The as-code narrative
below still holds; you just swap "Ansible installs the toolbox" for "run the devbox
tag." The [`paddock-deploy`](https://github.com/edspencer/paddock-deploy) recipes cover
both shapes.
:::

## Secrets: delivered at runtime, never committed

No token is ever written into an image or committed to a repo. Secrets live in a
**secrets manager** ([OpenBao](https://openbao.org)/Vault) and are delivered to the
container at runtime into a **tmpfs path under `/run`**, then loaded into the service's
environment. Each Paddock instance gets its **own** scoped credentials. If you're not
running a secrets manager, the humbler version is a root-only `.env` file the service
reads — the rule that matters is *scoped, out of version control, and not baked into
the image.*

## Authentication: one SSO in front of everything

The container publishes nothing directly. A **Caddy** reverse proxy terminates TLS and
delegates every request to **Authentik** (a self-hosted SSO/IdP) via `forward_auth`.
Paddock runs in **`jwt` mode**, validating the Authentik-signed token against that
application's JWKS URL — so identity is cryptographically verified, not merely trusted.

The payoff of a shared IdP: **one login, MFA, and per-user accounts across every
self-hosted app** — Paddock is just one of many behind the same front door. The full
patterns (Caddy `forward_auth`, `trusted-header` vs `jwt`) are in
[Securing Paddock](/guides/securing/).

## Multiple instances, one per area

Paddock is one process per data root + port, so the author runs **several instances** —
e.g. one per area of life — each with its **own data directory, port, scoped token, and
SSO application.** The reverse proxy maps a hostname to each. They share nothing but the
host.

## Managed as code

The whole estate is **infrastructure-as-code**: **OpenTofu** provisions the Proxmox
containers, **Ansible** configures the OS and the Paddock service (installs Node, the
`claude` CLI, `gh`, `ffmpeg`, PM2; renders the systemd units; wires up secrets), and
new tagged releases of the Paddock image **auto-deploy**. Changes go through a pull
request that shows a plan before it's applied. This makes the setup reproducible and
reviewable rather than a hand-built pet.

:::note
The author's home-lab repo is **private** — it encodes real internal topology and
addresses — so it isn't linked here. This guide describes the reproducible *shape* of
it; you don't need the same tools (any IaC, any secrets store, any SSO) to follow the
same pattern. The generalized, placeholder-only version of this OpenTofu + Ansible
shape lives in the public
[`paddock-deploy`](https://github.com/edspencer/paddock-deploy/tree/main/proxmox-iac)
`proxmox-iac/` recipe — start there.
:::

## The takeaway

None of this is required to enjoy Paddock — a single container behind a password works.
But if you want to lean on it, the winning recipe is: **an always-on, isolated host +
the right tools composed in + scoped secrets + SSO in front + managed as code.** That's
what turns Paddock into a dependable place where real work gets done.
