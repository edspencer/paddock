# Paddock

Paddock is a **project-first launchpad** on top of [`@herdctl/core`](https://github.com/edspencer/herdctl):
server-hosted, persistent, resumable **Claude Code sessions organized by project**.
A *project* is a directory + `project.yaml`; each project has one long-lived
**keeper** agent whose working directory *is* that directory; a *chat* is one
resumable Claude Code session belonging to a project; after each of your turns a
tool-less **sweeper** quietly curates the project's `OVERVIEW.md`/`CHANGELOG.md`.
herdctl runs the actual agents (as `claude -p` CLI subprocesses or SDK sessions)
and owns session discovery — Paddock is the thin, opinionated layer on top.

## Monorepo layout

Two `private` packages, versioned and released **together** (one number = "the
Paddock version"; not published to npm):

- **`packages/server`** (`@paddock/server`) — **Fastify 4 + `@fastify/websocket`**
  backend. Wraps herdctl's `FleetManager`, the Project layer, sidecar stores, the
  `/ws` streaming transport, in-process MCP tools, and the auth boundary; serves
  the built SPA in production. Entry: `index.ts` (lifecycle only) → `app.ts`
  `buildApp()` (all DI/wiring).
- **`packages/web`** (`@paddock/web`) — **React + Vite + Tailwind** SPA (Chat /
  Files / Changes / Settings), a PWA with a versioned service worker.

## Architecture pointers

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for depth (every claim there
is cited to `packages/server/src`). The essentials:

- **Three storage classes** (ARCHITECTURE §3) — keep them straight: (1) **transcript
  JSONL** written by Claude Code, Paddock reads/renders only (`~/.claude/projects/<enc-cwd>`
  symlinked to `<project>/.chats/`); (2) **browser localStorage** `paddock:*` client
  prefs (drafts, model, heights); (3) **server JSON sidecars** for durable app state
  (`ArchiveStore`, `ReadStateStore`, `QueuedMessageStore`, sweep watermark) — all
  write-through, corruption-tolerant, follow one shared pattern.
- **WS / session-hub flow** (§4) — all live chat runs over `GET /ws`. `ws.ts` drives
  the turn lifecycle; `session-hub.ts` fans out, buffers, and replays frames so a
  turn's stream survives socket death and re-attaches.
- **MCP injection** (§5) — keepers get extra tools via in-process MCP injection
  (`injectedMcpServers`), no network/auth: `send_file` on every turn, env-gated
  keeper-only self-management (`PADDOCK_SELF_MCP`). Automated/spawned turns get
  `send_file` only (anti-fork-bomb).
- **Auth boundary** (§7) — no native login; `auth.ts` `onRequest` hook turns
  upstream identity into `req.user` (`PADDOCK_AUTH_MODE`: `none` / `trusted-header`
  / `jwt`). See [`AUTH.md`](AUTH.md).
- **Sweeper + drive mode** (§6, §9) — post-turn tool-less `sweeper-<slug>` curates
  notes out of band. Keeper turns run `batch` (one-shot `trigger()`) or `session`
  (persistent `openChatSession`; background tasks / wake-ups survive the turn),
  per `PADDOCK_KEEPER_DRIVE_MODE` / `project.driveMode`.

Config is **entirely env-based** (`config.ts`, no config files) — see
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Dev conventions

Full guide: [`CONTRIBUTING.md`](CONTRIBUTING.md); run modes: [`DEV.md`](DEV.md).
Node 22+, `claude` CLI on `PATH`, a `CLAUDE_CODE_OAUTH_TOKEN` in env (never print
or commit it).

```bash
npm install                 # all workspaces
npm run dev                 # server on :4000 (API + WS)      — terminal 1
npm run dev:web             # Vite dev server, proxies to :4000 — terminal 2
npm run typecheck           # tsc on both packages
npm test                    # server (unit+integration) + web (component)
npm run test:e2e            # Playwright vs real server + a fake `claude` on PATH
```

- **`NODE_ENV=production` gotcha** (bites everyone once). A shell that exports it
  silently prunes dev deps (`tsc`/`vitest`/Playwright vanish) and breaks React
  `act()`. Install with `NODE_ENV=development npm install --include=dev`; run with
  the var unset: `env -u NODE_ENV npm test` / `env -u NODE_ENV npm run build`.
- **Branch for every non-trivial change; never force-push.** Conventional Commits
  (`type(scope): summary`). Open PRs against `main`; keep them small; CI (typecheck
  + tests + E2E) must be green.
- **Changesets** — add one in the same PR for user-facing changes (`npm run
  changeset`). Not needed for pure-internal or **docs-only** changes. Release flow
  (Docker image + tarball, no npm publish): [`RELEASING.md`](RELEASING.md).

## Where to find things

| For… | Read |
|---|---|
| How the code fits together | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What a project/keeper/chat/sweeper *is* | [`docs/concepts/`](docs/concepts/) |
| Running the full stack locally | [`DEV.md`](DEV.md) |
| Contributing, tests, gotchas | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Every `PADDOCK_*` env var | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) |
| REST + WebSocket contract | [`docs/API.md`](docs/API.md) |
| Test strategy & layers | [`docs/TESTING.md`](docs/TESTING.md) |
| Auth modes & secrets | [`AUTH.md`](AUTH.md) |
| Release pipeline | [`RELEASING.md`](RELEASING.md) |
| herdctl API contract Paddock depends on | [`docs/INTEGRATION.md`](docs/INTEGRATION.md) |
