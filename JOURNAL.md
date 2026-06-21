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
- Max OAuth token fails ON THE LXC → Ed AUTHORIZED (2026-06-21) using the
  commented-out Anthropic API key from `~/.zprofile`, but ONLY on the projects LXC
  / processes running in it (not elsewhere). Try OAuth (Max) first; only fall back
  to the API key (sdk runtime) if the token genuinely fails on the LXC.

## STATUS LOG (append-only; newest at bottom)

- 2026-06-20 — Orchestrator: repo + JOURNAL created. Pre-flight green (gh=edspencer,
  Proxmox reachable, Max token available). Dispatching P1 (scaffold+contract, provision).

- 2026-06-21 — Sub-agent F (scaffold + contract): **DONE.** npm-workspaces monorepo
  with `packages/server` (Fastify + @fastify/websocket) and `packages/web` (Vite +
  React + Tailwind, dark-mode, project-first shell). **Both build clean** (`tsc` for
  server, `vite build` for web) and `npm run typecheck` passes. Smoke-tested the
  server end-to-end: boots, FleetManager reaches `running`, `POST /api/projects`
  creates a project dir (project.yaml + CHANGELOG.md), regenerates herdctl config,
  hot-reloads, and the new `keeper-<slug>` agent appears live in `/api/fleet`.
  Wrote `docs/INTEGRATION.md` (full public `@herdctl/core@5.10.1` contract) and a
  REAL spike (`packages/server/src/spike.ts`) that typechecks AND runs against the
  package — constructs+initializes a FleetManager + SessionDiscoveryService.

  Integration contract verdict (verified against installed public package, not the
  symlink):
  - **(a) Construct/init:** `new FleetManager({configPath, stateDir})` →
    `initialize()` → `start()`. (Also `initializeWebOnly()` for zero-agent mode.)
  - **(b) Runtime agents — KEY FINDING:** NO programmatic `addAgent`. Agents load
    from `herdctl.yaml` on disk; the `agents` array accepts **path refs only** (no
    inline agents), and the `fleet` block is strict (name/description only). Dynamic
    agents = write per-agent yaml + regen herdctl.yaml + `fleet.reload()`. **Proven
    working** (smoke test). Paddock owns the generated config dir.
  - **(c) Stream/sessions:** `trigger(agent, undefined, {prompt, resume, onMessage})`.
    `onMessage(SDKMessage)` streams; `TriggerResult.sessionId` is the final id.
    New chat = `resume:null`, resume = `resume:<id>`, fallback = `undefined`.
  - **(d) Sessions model:** `SessionDiscoveryService.getAgentSessions(name, cwd,
    docker)` + `getSessionMessages(cwd, id)`, keyed on the agent's working_directory
    (= the project dir). Lower-level `listSessions`/`parseSessionMessages` also exported.
  - **(e) Events:** EventEmitter — `job:output`, `job:completed/failed/cancelled`,
    `config:reloaded`, `schedule:triggered`, `agent:started/stopped`, `error`, etc.
  - **(f) Transport reuse:** NONE in core. HTTP/WS chat transport lives in
    `@herdctl/web`/`@herdctl/chat`. We built our own (`ws.ts`), modeling the
    `chat:send`→`chat:response/tool_call/complete/error` shapes on @herdctl/web.

  GAPS needing a local herdctl change (PR candidates, all have app-layer
  workarounds today): (1) programmatic `FleetManager.addAgent()` to avoid yaml+reload;
  (2) first-class `fleet.getAgentSessions(name)` deriving cwd from config; (3) a
  reusable transport-agnostic SDKMessage→chat translation helper in @herdctl/chat;
  (4) a streaming trigger handle (async iterator) for cleaner WS cancel/backpressure.
  Full detail + code in `docs/INTEGRATION.md`. Note: bumped generated default model
  to `claude-sonnet-4-6` (the docs' `claude-sonnet-4-20250514` is deprecated Sonnet 4.0).

- 2026-06-21 — Sub-agent (backend, project-first chat server): **DONE + LIVE-VALIDATED.**
  Made the backend a real end-to-end project-first chat server and PROVED it with
  live Claude turns over WebSocket (Max OAuth token, `runtime: cli`, no API key).

  **What I built on top of the scaffold (didn't rewrite what worked):**
  - **Real WS streaming** (`ws.ts`): `chat:send {projectSlug|"scratch", sessionId|null,
    message}` → `fleet.trigger(keeper, undefined, {prompt, resume, onMessage})`,
    translating each SDKMessage to: `chat:response {chunk}` (assistant text deltas),
    `chat:tool_call {toolName, inputSummary, output, isError, durationMs}`,
    `chat:message_boundary`, `chat:complete {sessionId, success, error?}`,
    `chat:error {error}`. Tool calls are paired tool_use→tool_result **by id** using
    core's `extractToolUseBlocks`/`getToolInputSummary` + my own id-preserving
    result parser (core's `extractToolResults` short-circuits on the id-less
    top-level `tool_use_result`, losing pairing — so I read the nested
    `message.content[]` `tool_result` blocks directly). Result: correct tool names,
    input summaries, and real durations. Back-compat: accepts legacy `target` and
    emits both `projectSlug` + `target` so the existing web client keeps working.
  - **REST**: `GET /api/projects`, `POST /api/projects` (create+keeper+reload, kept),
    enriched `GET /api/projects/:slug` (metadata + changelog text + its chats),
    `GET /api/projects/:slug/chats`, **`GET /api/projects/:slug/chats/:sessionId/messages`**
    (resolves the working dir server-side, no `?dir=` needed), `GET /api/chats`
    (scratch sessions), `GET /api/chats/:sessionId/messages`.
  - **Keeper agent gen**: `runtime: cli`, `working_directory` = project dir,
    `model: claude-sonnet-4-6`, `max_turns: 200`, `permission_mode: acceptEdits`,
    `denied_tools: [Bash(sudo *), Bash(rm -rf /), Bash(rm -rf /*), Bash(chmod 777 *)]`.
    Docker isolation deferred (documented follow-up). Auth via process-env
    `CLAUDE_CODE_OAUTH_TOKEN` (never hardcoded).
  - **Portability fix (`config.ts`)**: canonicalize agent working dirs (resolve
    symlinks) at startup so SessionDiscoveryService finds Claude transcripts. macOS
    maps `/tmp`→`/private/tmp`; without this, session listing returned empty.
    No-op on the Linux LXC. Also invalidate the discovery cache on `chat:complete`
    so new sessions list immediately (vs the 30s TTL). PORT/data-root envs honored;
    static SPA served from `packages/web/dist` in prod; no laptop-absolute paths.

  **LIVE VALIDATION EVIDENCE (token sourced from ~/herds/.env into env, never
  printed; `claude` CLI 2.1.167 on PATH; Max OAuth, no API key):**
  Created project "Smoke Test", opened WS, sent "Say hello in one sentence, then
  create a file called hello.txt containing the word PADDOCK in your working dir."
  - (a) assistant text streamed as `chat:response` ("Hello! …", "Done! …"). ✓
  - (b) `chat:tool_call` fired for the file op: `toolName=Write`,
    `inputSummary=<dir>/hello.txt`, `isError=false`, `durationMs=74` (and a
    `Bash pwd` tool_call, `durationMs=309`). ✓
  - (c) `hello.txt` exists in the project dir containing exactly `PADDOCK`. ✓
  - (d) `chat:complete` returned a real `sessionId`
    (77f94bfb-…), `success=true`, with a `jobId`. ✓
  - (e) session listable via `GET /api/projects/smoke-test/chats` (resumable=true)
    and its 5 messages via the messages endpoint (roles user,assistant,tool,tool,assistant). ✓
  - (f) **resume/continuity**: sent "What word did you put in that file?" with the
    returned sessionId → "The word I put in the file is **PADDOCK**" and the SAME
    sessionId came back (not a new one). ✓
  Also validated the one-off **scratch** path end-to-end ("scratch-immediate-ok",
  listed immediately via `/api/chats` after cache invalidation).
  **typecheck + build clean** (server tsc, web tsc -b + vite, spike tsc).

  **WS EVENT CONTRACT for the frontend agent** (server always includes both
  `projectSlug` and the legacy `target` alias; `sessionId`/`jobId` on every event):
  - client→server: `chat:send {projectSlug|"scratch", sessionId|null, message}`,
    `chat:cancel {jobId}`, `ping`.
  - server→client: `chat:response {…, chunk}`; `chat:tool_call {…, toolName,
    inputSummary?, output, isError, durationMs?}`; `chat:message_boundary {…}`
    (one per assistant message — use to separate turn bubbles); `chat:complete
    {…, success, error?}` (the `sessionId` here is the canonical one to store for a
    NEW chat); `chat:error {projectSlug, target, error}`; `pong`.

  **Decisions/notes:** (1) scratch kept as a dedicated agent addressed by slug
  "scratch" (working_directory = data/scratch), not a fake project dir — simplest,
  reversible. (2) No Docker yet (POC reliability; LXC nesting is a follow-up).
  (3) Did NOT touch `packages/web` — back-compat aliasing means the current client
  still works; frontend agent should migrate to `projectSlug` + handle
  `chat:message_boundary`/`durationMs`. (4) Minor: chat list has a ~30s discovery
  cache TTL, now bypassed on completion via `invalidateAttributionCache`.
