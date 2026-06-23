# Paddock

A **project-first launchpad** built on [herdctl](https://github.com/edspencer/herdctl).
Projects are first-class; one-off chats are secondary. Server-hosted, persistent
Claude Code sessions organized by project — a web replacement for laptop Zellij tabs.

A **project** is just a directory containing a `project.yaml` (name, slug, status,
domain tags, visibility, summary), a `CHANGELOG.md`, and freeform files. Each
project gets a herdctl **keeper agent** whose working directory is the project
dir; the chats you see in the UI are that agent's Claude Code sessions, persisted
and resumable. One-off chats use a shared scratch agent and can be promoted into
a project (keeping their history).

The web UI is responsive — the same launchpad works from a phone.

## Layout

- `packages/server` — Fastify + WebSocket backend; wraps `@herdctl/core` FleetManager + a Project layer (`ProjectStore`). Serves the built SPA in production.
- `packages/web` — React + Vite + Tailwind project-first SPA.
- `docs/INTEGRATION.md` — the public `@herdctl/core` API contract paddock depends on.

## Develop

```bash
npm install                 # install all workspaces
npm run build               # build server (tsc) + web (vite)
npm run typecheck           # typecheck both packages
npm test                    # server (unit + integration) + web (component) tests
npm run test:e2e            # Playwright journeys (incl. mobile) against the real server + a fake `claude`

# Run locally (two terminals):
npm run dev                 # server on :4000 (API + WS)
npm run dev:web             # Vite dev server on :5173, proxies /api + /ws to :4000
```

The e2e suite drives the **real** server, FleetManager, and CLI runtime; only the
LLM is swapped for a fake `claude` binary on PATH (zero Anthropic calls). Opt into
a real-Claude run with `npm run test:e2e:live` (`PADDOCK_TEST_LIVE=1`).

## Run it

In production, `npm run build` then `npm run start` serves the API, the WS chat
transport, and the built SPA from one process. Configuration is environment-only:

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | HTTP/WS port |
| `HOST` | `0.0.0.0` | Bind address |
| `PADDOCK_DATA_DIR` | `./data` | Data root — holds `projects/`, `scratch/`, `.herdctl/` state, the generated `herdctl.yaml`. Setting this cascades all derived paths. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude auth for the **CLI** runtime (Max plan). |
| `ANTHROPIC_API_KEY` | — | Claude auth for the **SDK** runtime (API pricing). |

### Multiple instances

Paddock is one process per data root + port. To run several (e.g. one per area —
open-source / house / homelab), start one process each with its own
`PADDOCK_DATA_DIR` and `PORT`, and front them with a reverse proxy that maps a
hostname to each port. Nothing is shared between instances except the host.

## Credentials & secrets

**Paddock does not implement a secret store. It reads credentials from the
environment and from files the host has placed for it** — so bring whatever you
already use (env vars, Docker secrets, Kubernetes Secrets, a mounted SSH key) and
point Paddock at it. Nothing below is Paddock-specific machinery; it's the
platform's existing mechanism.

**Claude auth** — `CLAUDE_CODE_OAUTH_TOKEN` (Max) or `ANTHROPIC_API_KEY` (API),
supplied as an environment variable. Never commit it.

**GitHub — backing a project's data (recommended).** A Paddock data dir's
`projects/` folder can be a git repo that auto-commits and pushes (a durable,
versioned backup). Authenticate that push with a **per-repo SSH deploy key** —
narrowest possible scope, write to exactly one repo:

```bash
git -C "$PADDOCK_DATA_DIR/projects" config \
  core.sshCommand 'ssh -i /run/secrets/deploy_key -o IdentitiesOnly=yes'
```

**GitHub — broader push/pull (other repos).** Put a **fine-grained Personal
Access Token** in `GITHUB_TOKEN`; both `git` (via credential helper) and `gh`
pick it up. Scope it to the instance's needs — and to allow *everything except
deleting repos*, grant `Contents` + `Pull requests` (+ `Issues`/`Workflows`) and
**omit `Administration`** (the permission that controls repo deletion). Use a
tighter, repo-scoped token for less-trusted instances.

Paddock also ships an in-app **"Connect GitHub" device flow** (the Changes tab,
enabled by `PADDOCK_GITHUB_CLIENT_ID`) for an interactive, account-scoped OAuth
token when you don't want to mint a PAT.

**SSH keys (agents that SSH out to other machines).** If a keeper agent needs to
reach other hosts (a homelab agent administering servers, say), give it a key the
ordinary way — a file in the agent process's `~/.ssh` — and **isolate by deployment
boundary, not by Paddock**. One privileged key should live only where that one
instance runs.

### How that maps onto each deployment

| Platform | Env (token/auth) | Files (SSH key, deploy key) |
|----------|------------------|------------------------------|
| **systemd** | `EnvironmentFile=/etc/paddock-<name>.env` (mode 600); a second `EnvironmentFile` can layer per-instance overrides | Key in the service user's `~/.ssh/` (or a dedicated per-instance `$HOME`), mode 600 |
| **Docker** | `--env-file` / `-e GITHUB_TOKEN=…`, or **Docker secrets** (`/run/secrets/…`) | **Volume-mount read-only**: `-v $HOME/.ssh/id_ed25519:/home/app/.ssh/id_ed25519:ro` |
| **Kubernetes** | `Secret` → `envFrom`/`valueFrom.secretKeyRef` | `Secret` mounted as a file (`volumeMounts` → `~/.ssh/...`) |

The throughline: **one trust boundary per privileged credential.** Co-locating
instances that need different privilege levels in the same container/host/user
shares their secrets — split them across containers, hosts, or LXCs/VMs when the
isolation needs to be real.

## On herdctl

Paddock is a thin project layer over the public `@herdctl/core` FleetManager —
see `docs/INTEGRATION.md` for the exact API contract it depends on. Anything the
CLI/dashboard can do, the library can too; Paddock just wires projects, chats,
and a git backing store on top.
