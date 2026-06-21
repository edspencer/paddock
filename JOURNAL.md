# Paddock — build journal & shared brain

> **Paddock** = a project-first launchpad built on **herdctl**. Projects are the
> first-class citizen (like claude.ai but projects-first; one-off chats are
> secondary). Deployed to **https://projects.valfenda.net** in the homelab.
>
> This file is the shared brain for the overnight autonomous build. **Every
> sub-agent must read this first and append to the STATUS LOG when done.**
> Started 2026-06-20 (overnight). Owner: Ed (asleep). Orchestrator: Claude.

## Mission (from Ed)

Build a working POC, overnight (~8h), of a project-oriented web app that replaces
his laptop Zellij-tabs workflow with persistent, server-hosted Claude Code
sessions organized by **project**. "New Project" / "New Chat" buttons. Most chats
live inside a project; one-off chats supported but secondary.

## Locked decisions

| Decision | Choice |
|---|---|
| Auth for deployed service | **Claude Max** (`runtime: cli`, `CLAUDE_CODE_OAUTH_TOKEN`) |
| Deploy target | **New dedicated LXC** on Proxmox; `projects.valfenda.net` via Caddy on netops |
| Priority if time short | **A deployed, working POC** above all |
| Project-model locus | **Hybrid** — app-layer now; push to herdctl core (local + PR) where it clearly belongs |
| Trust posture (per-project agents) | Docker-isolated preferred; fall back to `acceptEdits` + denied dangerous bash if nested Docker in the LXC is troublesome |
| Build baseline | **Public npm**: `@herdctl/core@5.10.1`, `@herdctl/web@0.9.10`, `@herdctl/chat@0.3.14` — NOT the local symlink |
| herdctl fixes | Local only in `~/Code/herdctl` (branch + changeset + PR text). **NEVER push to any remote.** |
| New repos | Up to 3 private GitHub repos under `edspencer`. Expect to need 1 (`paddock`). |

## Hard constraints

- **Do NOT push herdctl changes to any remote branch.** Local commits + a prepared PR only.
- Max 3 private repos.
- Never print secrets (CLAUDE_CODE_OAUTH_TOKEN, firewall key, ssh keys). Read into env/files only.
- Don't break the live homelab. The new LXC is additive. Don't touch other LXCs/agents.

## Homelab facts (deploy)

- Domain: **valfenda.net** (note: Ed sometimes says "valfender"). Internal + Tailscale only.
- Reverse proxy: **Caddy on netops (192.168.1.33)**, Let's Encrypt via DNS-01.
- DNS: **Unbound host-overrides on OPNsense (192.168.1.1)** via API (creds in
  `~/herds/personal/homelab/firewall-key.txt`, basic auth `-u key:secret`).
  After change: reconfigure unbound, then `pihole reloaddns` on 192.168.1.53 & .54.
- Proxmox cluster `valfenda`, nodes pve-1..5 (pve-1 = 192.168.1.71), shared NFS.
  Create LXC with `pct` on a node. Add the **claude ssh key** to the new LXC
  (`~/herds/personal/homelab/claude-ssh-key.pub`). Add `~/.ssh/config` alias.
- SSH aliases that work today: `netops`, `devbox` (runs herdctl), `pve-1`.
- IP registry: `~/herds/personal/homelab/IP-ALLOCATIONS.md`. Pick a free IP in the
  192.168.1.x server range for the new LXC; reserve in registry.
- Proven pattern to mirror: **devbox** (192.168.1.35) already runs herdctl + web
  behind Caddy with Max auth — copy its setup for the projects LXC.
- Max token: `CLAUDE_CODE_OAUTH_TOKEN` in `~/herds/.env`. Deployed service needs
  Node 22 + the `claude` CLI + this token in env.

## Architecture (hybrid, app-layer first)

```
Browser ──https──> Caddy(netops) ──> projects.valfenda.net LXC
                                        │
                                        ├─ paddock-server (Fastify + WS)
                                        │     uses @herdctl/core FleetManager
                                        │     + a Project layer (dirs + metadata + keeper agents)
                                        └─ paddock-web (React/Vite SPA, project-first)
```

- **Project** = a directory (reuse the standard from `~/herds/personal/projects/`:
  `project.yaml`, `CHANGELOG.md`, freeform md) + a herdctl **keeper agent**
  (`working_directory` = the project dir, `runtime: cli`, Max auth) + its sessions.
- **Chat** = a herdctl session for that project's agent. "New chat" = new session;
  switching = resume. One-off chats = sessions in a default scratch dir.
- Backend wraps `@herdctl/core` (create/trigger/resume/stream/list). Reuse
  `@herdctl/web`/`@herdctl/chat` patterns/transport where the public API allows.
- Where the public API can't do what we need → sub-agent investigates
  `~/Code/herdctl` source → local fix in herdctl → app points at local build →
  prepare PR.

## Phase plan

- **P0 (done):** repo + JOURNAL + GitHub private repo.
- **P1 (parallel):** (F) scaffold paddock (server+web) on public herdctl + write
  `docs/INTEGRATION.md` (exact public API contract). (P) provision the LXC.
- **P2:** backend (project model + API + WS chat) and frontend (project-first UI).
- **P3:** integrate + local smoke test (create project → new chat → streamed Claude reply).
- **P4:** deploy to LXC; Caddy + Unbound DNS; verify projects.valfenda.net e2e.
- **P5:** herdctl local fixes → branch + changeset + PR text (no push).

## Fallbacks

- Nested Docker in LXC painful → run keeper agents without Docker (`acceptEdits` +
  denied dangerous bash), note hardening as follow-up.
- New-LXC provisioning blocked → deploy onto **devbox** instead (Ed's #2 choice).
- Public `@herdctl/core` missing a needed API → use local herdctl build for that
  piece + PR; document the gap here.

## STATUS LOG (append-only; newest at bottom)

- 2026-06-20 — Orchestrator: repo + JOURNAL created. Pre-flight green (gh=edspencer,
  Proxmox reachable, Max token available). Dispatching P1 (scaffold+contract, provision).
