# Paddock

A **project-first launchpad** built on [herdctl](https://github.com/edspencer/herdctl).
Projects are first-class; one-off chats are secondary. Server-hosted, persistent
Claude Code sessions organized by project — a web replacement for laptop Zellij tabs.

Deployed at `https://projects.valfenda.net` (homelab, internal/Tailscale only).

See **JOURNAL.md** for the live build plan and status.

## Layout
- `packages/server` — Fastify + WebSocket backend; wraps `@herdctl/core` FleetManager + a Project layer (`ProjectStore`). Serves the built SPA in production.
- `packages/web` — React + Vite + Tailwind project-first SPA.
- `docs/INTEGRATION.md` — the public `@herdctl/core` API contract paddock depends on (verified against the installed package).

Built on public `@herdctl/core` (5.10.1); points at a local herdctl build only for fixes we PR upstream.

## Develop

```bash
npm install                 # install all workspaces
npm run build               # build server (tsc) + web (vite)
npm run typecheck           # typecheck both packages
npm run -w packages/server spike   # prove the @herdctl/core integration (constructs a FleetManager)

# Run locally (two terminals):
npm run dev                 # server on :4000 (API + WS)
npm run dev:web             # Vite dev server on :5173, proxies /api + /ws to :4000
```

In production, `npm run build` then `npm run start` serves the API, the WS chat
transport, and the built SPA from one process (`PORT`, default 4000).

## Model

A **project** is a directory under the data root containing `project.yaml`
(name, slug, status, domain[], visibility, started/updated, summary) +
`CHANGELOG.md` + freeform files — the standard from `~/herds/personal/projects/`.
Each project gets a herdctl **keeper agent** whose `working_directory` is the
project dir; chats are that agent's Claude Code sessions. One-off chats use a
shared scratch agent. See `docs/INTEGRATION.md` for how this maps onto the
public herdctl API (and where it can't yet).
