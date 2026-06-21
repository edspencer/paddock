# Paddock

A **project-first launchpad** built on [herdctl](https://github.com/edspencer/herdctl).
Projects are first-class; one-off chats are secondary. Server-hosted, persistent
Claude Code sessions organized by project — a web replacement for laptop Zellij tabs.

Deployed at `https://projects.valfenda.net` (homelab, internal/Tailscale only).

See **JOURNAL.md** for the live build plan and status.

## Layout (planned)
- `packages/server` — Fastify + WebSocket backend; wraps `@herdctl/core` FleetManager + a Project layer.
- `packages/web` — React/Vite project-first SPA.

Built on public `@herdctl/core` (5.10.x); points at a local herdctl build only for fixes we PR upstream.
