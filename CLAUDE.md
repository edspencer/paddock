# Paddock

Paddock is a **project-first launchpad** on top of [`@herdctl/core`](https://github.com/edspencer/herdctl):
server-hosted, persistent, resumable **Claude Code sessions organized by project**.
A *project* is a directory + `project.yaml`; each project has one long-lived
agent whose working directory *is* that directory; a *chat* is one
resumable Claude Code session belonging to a project; after each of your turns a
tool-less **sweeper** quietly curates the project's `OVERVIEW.md`/`CHANGELOG.md`.
herdctl runs the actual agents and owns session discovery — Paddock is the thin,
opinionated layer on top. Chats run on herdctl's **Claude Agent SDK** streaming
runtime by default; only the sweeper, triggers, and `driveMode: batch` projects
shell out to a one-shot `claude -p` CLI subprocess (see the drive-mode note
below).

## Monorepo layout

Two `private` packages, versioned and released **together** (one number = "the
Paddock version"). Neither is published under its own name — releases synthesize
a single public **`@edspencer/paddock`** package from their built output
(`scripts/make-npm-package.mjs`), so the workspace manifests stay `private`:

- **`packages/server`** (`@paddock/server`) — **Fastify 4 + `@fastify/websocket`**
  backend. Wraps herdctl's `FleetManager`, the Project layer, sidecar stores, the
  `/ws` streaming transport, in-process MCP tools, and the auth boundary; serves
  the built SPA in production. Entry: `index.ts` (lifecycle only) → `app.ts`
  `buildApp()` (all DI/wiring).
- **`packages/web`** (`@paddock/web`) — **React + Vite + Tailwind** SPA (Chat /
  Files / Changes / Settings), a PWA with a versioned service worker.

## Architecture pointers

Read [`website/src/content/docs/architecture/overview.md`](website/src/content/docs/architecture/overview.md)
for depth (every claim there is cited to `packages/server/src`, by file + symbol,
never by line number). The essentials:

- **Three storage classes** (ARCHITECTURE §3) — keep them straight: (1) **transcript
  JSONL** written by Claude Code, Paddock reads/renders only
  (`<dataDir>/claude-home/projects/<enc-cwd>` symlinked to `<project>/.chats/`, or out at
  the user's own folder under `claude.transcripts: host`); (2) **browser localStorage** `paddock:*` client
  prefs (drafts, model, heights); (3) **server JSON sidecars** for durable app state
  (`ArchiveStore`, `ReadStateStore`, `QueuedMessageStore`, sweep watermark) — all
  write-through, corruption-tolerant, follow one shared pattern.
- **WS / session-hub flow** (§4) — all live chat runs over `GET /ws`. `ws.ts` drives
  the turn lifecycle; `session-hub.ts` fans out, buffers, and replays frames so a
  turn's stream survives socket death and re-attaches.
- **MCP injection** (§5) — agents get extra tools via in-process MCP injection
  (`injectedMcpServers`), no network/auth: `send_file` on every turn, env-gated
  project-only self-management (`PADDOCK_SELF_MCP`). Automated/spawned turns get
  `send_file` only (anti-fork-bomb).
- **Auth boundary** (§7) — no native login; `auth.ts` `onRequest` hook turns
  upstream identity into `req.user` (`PADDOCK_AUTH_MODE`: `none` / `trusted-header`
  / `jwt`). See [`AUTH.md`](AUTH.md).
- **Sweeper + drive mode** (§6, §9) — post-turn tool-less `sweeper-<slug>` curates
  notes out of band (always a one-shot `trigger()`, so always the CLI runtime).
  Chat turns run `batch` (one-shot `trigger()`, CLI runtime) or `session`
  (persistent `openChatSession`, which hard-codes the SDK runtime; background
  tasks / wake-ups survive the turn), per `PADDOCK_DRIVE_MODE` /
  `project.driveMode`. `session` is the default, so **chats normally run on the
  SDK, not `claude -p`**.

Config resolves **env > YAML file > default** (`config.ts`; the file is
`<dataDir>/paddock.config.yaml`) — see
[`environment.md`](website/src/content/docs/configuration/environment.md) for every
variable and [`config-file.md`](website/src/content/docs/configuration/config-file.md)
for the file. The `claude:` block there says what an instance shares with the host's
Claude Code (`transcripts: own|host`, `credentials: own|host`, #691); paddock ALWAYS
owns its Claude home (`<dataDir>/claude-home`) and refuses to start if it resolves to
the user's `~/.claude`. `credentials` is the one key defaulting to `host` — isolation
is about writes, and reading a login writes nothing (see `claude-credentials.ts`).

## Dev conventions

Full guide: [`CONTRIBUTING.md`](CONTRIBUTING.md); run modes: [`DEV.md`](DEV.md).
Node 22+, a `CLAUDE_CODE_OAUTH_TOKEN` in env (never print or commit it), and a
`claude` CLI on `PATH` **for the sweeper and triggers only** — chats resolve the
SDK's own bundled binary and never consult `PATH`.

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

**The documentation website is the source of truth**, and its content is plain
markdown checked into this repo under `website/src/content/docs/` — read those
files directly, no fetching. `docs/` is a stale fork kept only until it is
deleted; prefer the website copy whenever both exist. The handful of root files
below (`AUTH.md`, `CONTRIBUTING.md`, `DEV.md`, `RELEASING.md`) are contributor
runbooks the website does not own, and stay canonical here.

| For… | Read |
|---|---|
| How the code fits together | [`website/src/content/docs/architecture/overview.md`](website/src/content/docs/architecture/overview.md) |
| What a project/agent/chat/sweeper *is* | [`website/src/content/docs/concepts/`](website/src/content/docs/concepts/) |
| Running the full stack locally | [`DEV.md`](DEV.md) |
| Contributing, tests, gotchas | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Every `PADDOCK_*` env var | [`website/src/content/docs/configuration/environment.md`](website/src/content/docs/configuration/environment.md) |
| REST endpoints | [`openapi-site/open-api.json`](openapi-site/open-api.json) — the OpenAPI 3 spec, generated from the Fastify route schemas (published at `/api/`; live on an instance at `/open-api` when `PADDOCK_OPENAPI_ENABLED=1`) |
| WebSocket (`/ws`) frame contract | [`website/src/content/docs/reference/websocket.md`](website/src/content/docs/reference/websocket.md) — hand-maintained; OpenAPI cannot describe it |
| Test strategy & layers | [`website/src/content/docs/contributing/testing.md`](website/src/content/docs/contributing/testing.md) |
| Auth modes & secrets | [`AUTH.md`](AUTH.md) |
| Release pipeline | [`RELEASING.md`](RELEASING.md) |
| herdctl API contract Paddock depends on | [`website/src/content/docs/architecture/herdctl-integration.md`](website/src/content/docs/architecture/herdctl-integration.md) |
| Regenerating the README/docs demo reel | [`scripts/demo-gif/README.md`](scripts/demo-gif/README.md) |

**The demo reel is generated, not hand-made.** `docs/demo/paddock-demo.gif` (and
its copy under `website/public/demo/`) comes out of `npm run demo:gif` — a
committed seed/shoot/build pipeline that stages a synthetic instance, drives it,
and photographs it. Never edit or hand-replace those files; change
`scripts/demo-gif/beats.mjs` (the storyboard) or `fixtures.mjs` (the content) and
re-run. It went 26 minor versions stale once because the original was ad-hoc and
undiscoverable — worth refreshing whenever a release changes what the UI looks
like.
