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

- 2026-06-21 — Sub-agent (frontend, project-first web UI): **DONE.** Rebuilt
  `packages/web` into a genuinely polished, project-first SPA on top of the
  scaffold and the LIVE backend contract (matched `server/src/{ws,routes}.ts`
  exactly; **migrated fully off the legacy `target` field to `projectSlug`**).

  **UI shipped:**
  - **Landing (`/`)**: projects grid — cards with name, status pill (dot +
    color), domain tags, live chat/session count (lazy `GET /:slug/chats`), and
    relative last-activity. Primary **+ New Project**; lighter secondary **New
    chat**. Inviting empty state. Sidebar mirrors it (project nav + the two CTAs).
  - **New Project**: polished modal (name, summary, domain tags, status select);
    Esc to close, scale-in anim → `POST /api/projects` → navigates into the project.
  - **Project view (`/projects/:slug`)**: header (name, status, domains, updated),
    left session list with **+ New Chat**, chat pane, and a **Files & Changelog**
    tab rendering project.yaml summary/metadata + `CHANGELOG.md` as markdown — all
    from the enriched `GET /:slug` (`{project, changelog, chats}`).
  - **Chat pane (core)**: shared auto-reconnecting WS (`lib/ws.ts`) with ping
    keepalive and **per-chat routing by projectSlug/sessionId**. Renders streaming
    `chat:response` as live **markdown** (react-markdown + remark-gfm) with a
    blinking caret; `chat:tool_call` as tidy **collapsible** blocks (name, input
    summary, output, error state, duration via `durationMs`); uses
    `chat:message_boundary` to split assistant turns into separate bubbles; on
    `chat:complete` stores the returned `sessionId` (resumes next turn + refreshes
    lists); shows `chat:error` inline. Composer: auto-growing textarea, Enter to
    send / Shift+Enter newline, disabled while streaming, **Stop** → `chat:cancel`.
    Auto-scroll only when pinned. Resumed sessions **hydrate** from the messages
    endpoints.
  - **One-off chat (`/chat`, `/chat/:sessionId`)**: same pane against
    `projectSlug:"scratch"`, with its own recent-list; clearly secondary in the IA.
  - **Polish**: Tailwind, dark-mode (default), responsive; warm "paddock" neutrals
    + a single terracotta `accent`; Inter/JetBrains Mono; custom scrollbars,
    skeletons, fade/scale anims; inline SVG icon set (no icon dep).

  **Contract mapping** is documented in `packages/web/README.md`; **full-stack
  local run** (server + Max token + web, both prod-like and hot-reload) in root
  **`DEV.md`**. Added deps: `react-markdown@9`, `remark-gfm@4`.

  **VALIDATION:** `npm run -w packages/web build` (tsc -b + vite) **clean**; root
  `npm run typecheck` (server + web) **clean**; full `npm run build` **clean**.
  **Served smoke test** (token sourced from `~/herds/.env` into env, never
  printed; temp `PADDOCK_DATA_DIR`; PORT 4011): server boots, **app shell loads at
  `/`** (text/html), built `/assets/*.js|css` serve 200, **SPA fallback** serves
  index.html for client routes (`/projects/foo`), and through the served app
  `GET /api/projects`, `POST /api/projects`, enriched `GET /:slug`
  (`{project,changelog,chats}`), `/:slug/chats`, and `/api/chats` all return the
  shapes the typed client expects. Server stopped + temp data cleaned afterward.
  Did **not** modify `packages/server`.

  **For the orchestrator (visual/Playwright pass):** (1) drive a real Claude turn
  end-to-end (create project → New Chat → send a message that uses a tool) to see
  streaming markdown + a collapsible tool block + the session appearing in the
  left list on completion; (2) reload + reopen the session to confirm history
  hydration; (3) check the one-off `/chat` path. **Rough edges:** fonts load from
  Google Fonts at runtime (system-ui fallback if the LXC client is offline);
  bundle is ~399KB/125KB gzip (react-markdown) — fine for a POC, code-split later
  if desired; after a NEW project chat completes, the in-progress pane keeps its
  live transcript while the saved session also appears in the list (claude.ai-like)
  — clicking the list entry re-hydrates from history (brief flash, acceptable).

- 2026-06-21 — Sub-agent (browser E2E verification): **DONE. FULL STACK PROVEN IN A
  REAL BROWSER — 7/7 flows green.** Built everything, ran the single-process server
  (Max OAuth, no API key; temp `PADDOCK_DATA_DIR`, PORT 4022) and drove a real
  Chromium (Playwright) through the whole workflow. Script committed at
  `scripts/e2e.mjs`; 10 screenshots committed under `docs/screenshots/`
  (01-landing … 10-final).

  **Results (all PASS):** (1) landing/empty-state renders; (2) New-Project modal →
  create "Demo Project" + domain tag + summary → navigates into the project view;
  (3) New Chat → prompt that streams markdown text live, renders TOOL BLOCKS
  (Write/Bash, with durations + an error-state block), session lands in the left
  list on completion, and `notes.md` ("paddock works") verified on disk; (4) reload
  + reopen the session → full transcript HYDRATES from history (user + assistant +
  all tool blocks); (5) follow-up "what did you write in notes.md?" → answers
  "paddock works" (resume/continuity proven in the UI); (6) one-off `/chat` scratch
  reply streams; (7) final polished project view. UI looks genuinely finished —
  dark theme, terracotta accent, status pills, collapsible tool blocks, markdown,
  auto-scroll, live "connected" indicator.

  **BUGS FOUND + FIXED:**
  1. **Misleading "updated 5h ago" on a just-created project (FIXED).** `project.yaml`
     stores `started`/`updated` as date-only `YYYY-MM-DD` (the homelab projects
     standard — kept as-is). The web `relativeTime()` parsed a bare date as
     **midnight UTC**, so a project touched today rendered "Nh ago" (N = current UTC
     hour). Fixed in `packages/web/src/lib/format.ts`: date-only values now render a
     calendar-relative label in the viewer's local tz (today / yesterday / Nd ago).
     Now shows "updated today". Full ISO timestamps (session mtimes) are unaffected
     and still show "just now". Rebuilt; re-ran E2E green; visible in 10-final.png.
  2. **Session discovery silently returns [] when the data-dir PATH CONTAINS A DOT
     (env/harness gotcha, NOT a paddock product bug — but a real deploy caveat).**
     My first run used `mktemp -d /tmp/paddock-e2e.XXXXXX` (note the `.`). Claude
     Code encodes that project cwd's transcript dir as `…-paddock-e2e-LdCOid-…`
     (`.`→`-`), but `@herdctl/core`'s `encodePathForCli()` produces
     `…-paddock-e2e.LdCOid-…` (keeps the `.`). The two disagree, so
     `SessionDiscoveryService.getAgentSessions()` looks in the wrong dir and finds
     nothing → empty chat list (flows 3/4/7 failed; the turn + `notes.md` + in-memory
     resume all still worked, proving it was purely a discovery-path mismatch). Root
     cause isolated by hand (attribution index + sidechain filter both fine; the
     mismatch is the encoder). Fixed the run by using a **dot-free** temp dir →
     all green. **Implications:** production paths (`/data/projects/<slug>`, slugs are
     kebab-case, no dots) are unaffected, so the product is correct as-is. ACTIONS for
     orchestrator/Ed: (a) on the LXC, keep `PADDOCK_DATA_DIR` dot-free (e.g.
     `/var/lib/paddock` or `/data`, NOT something like `/srv/app.v2/...`). (b) New
     herdctl PR candidate (add to docs/INTEGRATION.md gap list): `encodePathForCli`
     should encode `.`→`-` to match Claude Code's own transcript-dir encoding, OR
     paddock should defensively reject/normalize dots in resolved project dirs.

  **VALIDATION:** `npm run build` + `npm run typecheck` clean before commit. Server
  stopped, all temp data + test Claude transcripts removed. Playwright added as a
  root devDependency; browser binaries live in the OS cache (NOT committed) and
  `.gitignore` extended with playwright output dirs. `scripts/e2e.mjs` is rerunnable:
  `BASE_URL=… PADDOCK_DATA_DIR=… node scripts/e2e.mjs` (exit 0 = all green).

- 2026-06-21 — Sub-agent (DEPLOY to homelab LXC): **DONE. https://projects.valfenda.net
  IS LIVE AND WORKING END-TO-END, with Claude Max OAuth (NO API-key fallback needed).**
  Drove a real chat through the public HTTPS URL in a browser → keeper agent wrote a
  file on disk under `/var/lib/paddock`. All 7 deploy steps applied; shared infra
  touched surgically + additively, with backups, and existing services confirmed intact.

  **What was deployed (LXC `projects` @ 192.168.1.83, CTID 123, pve-1):**
  - **Code**: shipped the working tree to `/opt/paddock` via `tar | ssh` (rsync absent
    on the LXC; excluded node_modules/dist/.git/data). `npm ci` (436 pkgs) + `npm run
    build` → both packages built clean. Entrypoint `packages/server/dist/index.js`;
    SPA served from `packages/web/dist` (relative `../../web/dist` resolves correctly).
  - **Env**: `/etc/paddock.env` (mode 600, root) — `CLAUDE_CODE_OAUTH_TOKEN` piped over
    ssh from `~/herds/.env` (never printed; verified 108-char `sk-ant-oat…` transferred
    intact), `PORT=4000`, `HOST=0.0.0.0`, **`PADDOCK_DATA_DIR=/var/lib/paddock`
    (DOT-FREE per the caveat above)**, `NODE_ENV=production`. Data dir created.
  - **systemd**: `/etc/systemd/system/paddock.service` mirrors devbox's herdctl.service
    (Type=simple, User=root, WorkingDirectory=/opt/paddock,
    `ExecStart=/usr/bin/node packages/server/dist/index.js`, Restart=always,
    EnvironmentFile=/etc/paddock.env). **PATH includes `/usr/local/bin`** (+ `/root/.local/bin`)
    so keeper agents can spawn `claude` (2.1.185, symlinked at /usr/local/bin/claude).
    `enable --now`; **active, listening 0.0.0.0:4000**; survives `systemctl restart`
    (projects persist on disk). `/api/health`→`{"ok":true}`, `/api/projects`→JSON.

  **TOKEN VERIFICATION ON THE LXC (the critical step) — OAuth WORKS:**
  Created project "Deploy Smoke" via the API, opened a WS on the LXC, sent a prompt to
  write a file. Result: assistant text streamed (`chat:response`), **Bash `pwd` (127ms)
  + Write tool_calls fired**, `chat:complete success=true` with real sessionId
  `2c00a035-…`. On disk: `/var/lib/paddock/projects/deploy-smoke/deploy-proof.txt` ==
  `LXCLIVE`. Session listable + resumable via `/api/projects/deploy-smoke/chats`.
  **No `runtime: sdk` / ANTHROPIC_API_KEY fallback was needed — Max OAuth authenticated
  cleanly on the LXC.** (Note for future debugging: the WS client contract is
  `{type:"chat:send", payload:{projectSlug, sessionId, message}}` — a flat-field
  message is rejected as "Unknown message"; server replies are `{type, payload:{…}}`.)

  **Shared infra changed (SURGICAL + ADDITIVE, backups taken, existing services
  re-verified):**
  - **Caddy on netops (192.168.1.33, docker `caddy`)**: backed up
    `/opt/netops/caddy/Caddyfile` → `Caddyfile.bak.1782018728`, appended a
    `projects.valfenda.net { tls{dns cloudflare …} reverse_proxy 192.168.1.83:4000 }`
    block mirroring the devbox block EXACTLY. `caddy validate` → "Valid configuration";
    hot `caddy reload`. **devbox.valfenda.net + podcasts.valfenda.net still HTTP 200**
    after reload (no regression).
  - **DNS (Unbound on OPNsense via API)**: added host override
    `projects.valfenda.net → 192.168.1.33` (netops/Caddy), uuid
    `27496a8f-f23b-4fd3-bf4f-2b5b95258cc3`; `unbound/service/reconfigure` → `{"status":"ok"}`.
    `pihole reloaddns` on .53 (via `pihole-1` alias) and .54 (via `pihole-2` alias).
    Note: pihole-2's host key had legitimately rotated (ecdsa→ed25519); removed ONLY the
    stale `known_hosts` line for .54 (`ssh-keygen -R`) so ssh re-learned it — did NOT
    disable host-key checking globally. `dig +short projects.valfenda.net` → 192.168.1.33
    on Unbound, BOTH pi-holes, and the laptop default resolver. devbox still resolves
    (no regression).
  - **`~/herds/personal/homelab/IP-ALLOCATIONS.md`**: added the
    `192.168.1.83 | projects | … | pve-1 LXC 123` row under Development Workloads.

  **END-TO-END FROM THE LAPTOP (the headline result):**
  - `curl https://projects.valfenda.net/` → HTTP 200, serves the SPA; **valid Let's
    Encrypt cert** `CN=projects.valfenda.net` (issued 04:14 UTC, auto via DNS-01; no
    wait needed). `/api/projects` + `/api/health` return JSON over HTTPS.
  - **Playwright against the LIVE https URL**: created project "Live Verify 14043"
    through the real UI, sent a chat over the live WS → keeper agent wrote
    `/var/lib/paddock/projects/live-verify-14043/live-proof.txt` == `HTTPSLIVE`
    (irrefutable proof the whole browser→Caddy→LXC→herdctl→Claude(OAuth)→tool chain
    works). Session `f30eb1c6-…` persisted + resumable over HTTPS. Screenshots:
    `docs/screenshots/live-01-landing|02-new-project|03-project-view|05-complete.png`
    (05 shows the project view with the user bubble + a rendered Bash tool block + the
    "connected" WS indicator).

  **Remaining / honest caveats:** (1) two test projects ("Deploy Smoke",
  "Live Verify 14043") were left on the LXC as living proof — delete their dirs under
  `/var/lib/paddock/projects/` if a clean slate is wanted. (2) Keeper agents still run
  WITHOUT Docker isolation (acceptEdits + denied dangerous bash) — the documented
  follow-up; the LXC has `nesting=1` ready when we want to add it. (3) The web SPA
  loads fonts from Google Fonts at runtime (system-ui fallback if offline). (4) Caddy
  reload emits pre-existing `header_up`/formatting warnings from OTHER blocks (not from
  ours) — cosmetic. Full applied state mirrored into `~/Code/paddock-deploy-notes.md`.

- 2026-06-21 — Sub-agent (enhancements: project/chat management, self-hosted fonts,
  polish): **DONE. 10/10 E2E green (all 7 proven flows + 3 new assertions).** Tight,
  low-risk improvements on top of the live app; nothing in the proven flows changed
  behaviorally. Built + typechecked clean; ran the FULL browser E2E against a real
  server (Max OAuth, dot-free temp `PADDOCK_DATA_DIR`, real Claude turns) — all pass.

  **1) Project management (backend + UI):**
  - `DELETE /api/projects/:slug` — `ProjectStore.remove()` rm's the project dir (guarded
    to stay under projectsRoot), then `HerdctlService.removeProjectAgent()` regenerates
    herdctl.yaml from the SURVIVORS, deletes the orphaned `agents/keeper-<slug>.yaml`,
    and `fleet.reload()` (the exact inverse of the create flow — `reload()` cleanly
    computes removed agents + updates the scheduler). `PATCH /api/projects/:slug` already
    existed and is now wired in the UI.
  - UI: a reusable **"…" overflow menu** (`ProjectMenu`) on every project **card** AND in
    the **project header** with **Edit details** + **Delete project**; a shared
    **`ConfirmDialog`** (Esc-cancel, busy state, error surface) gates the destructive
    delete; an **`EditProjectModal`** PATCHes status/summary/domain and the change is
    reflected immediately (header + grid) AND verified persisted server-side by the E2E.
    Local optimistic `remove()`/`upsert()` added to the projects context.
  - E2E proves: deleted project disappears from the grid, its `keeper-<slug>` is gone
    from `/api/fleet`, the project 404s, and its dir is removed on disk.

  **2) Chat/session management — SUPPORTED (not skipped).** The public API surfaces
  `getCliSessionFile(workingDir, sessionId)` (deep import
  `@herdctl/core/dist/runner/runtime/cli-session-path.js`; no `exports` map gates it, and
  it VALIDATES the sessionId — rejects path traversal). That computes the exact
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl` the SessionDiscoveryService reads, so
  deleting a chat = `fs.unlink` that file + `invalidateAttributionCache`. Added
  `DELETE /api/projects/:slug/chats/:sessionId` and `DELETE /api/chats/:sessionId`, plus a
  hover **trash affordance** + confirm on every chat row (project + one-off lists).
  Verified end-to-end by hand: endpoint returns `{ok,removed:true}`, list count drops,
  transcript JSONL gone from disk. **Rename was skipped** (optional per spec; the
  `SessionMetadataStore` custom-name write path isn't surfaced cleanly through the public
  barrel — left as a clean follow-up rather than hacked).

  **3) Self-hosted fonts (offline-safe on the LAN).** Removed the runtime Google Fonts
  `<link>` from `index.html`. Inter + JetBrains Mono are **variable** fonts — the latin
  subset is a single woff2 each — so `packages/web/public/fonts/{inter,jetbrains-mono}-latin.woff2`
  (~48KB + ~31KB) cover all weights via `@font-face` (`font-weight: 100 900`/`100 800`,
  `font-display: swap`) in `index.css`. `system-ui` fallback kept in the Tailwind stacks.
  Vite copies `public/` → `dist/fonts/`; the server's static handler serves them
  (`200 font/woff2`). E2E asserts **zero** requests to fonts.googleapis/gstatic, the local
  woff2 serves 200, and `getComputedStyle(body).fontFamily` resolves to Inter.

  **4) Polish.** Fixed sidebar domain-tag wrapping (cap 2 tags + `+N`, truncate, no-wrap
  overflow). Card title `line-clamp-2` + `min-w-0` so it never collides with the status
  pill/menu; card domains cap at 4 + `+N`, truncate. Dark-mode `.tag` contrast bumped
  (`paddock-800`/`paddock-200`). Added `.btn-danger`, `.menu*` component classes.

  **VALIDATION:** `npm run typecheck` + `npm run build` clean (web bundle 409KB/127KB
  gzip, unchanged). Server stopped, temp data + this run's `~/.claude/projects/*` test
  transcripts removed; no Playwright binaries committed. Screenshots refreshed under
  `docs/screenshots/` incl. new **11-project-menu**, **12-delete-confirm**,
  **13-edit-metadata** (overwrote 02–10 from this run). Committed + pushed to `main`.

  **Honest notes:** (a) the chat-delete helper is a DEEP import into core's `dist/`
  (public function, but not re-exported from the package barrel) — robust today (no
  `exports` map), but a clean PR candidate is to surface `getCliSessionFile` (and a
  first-class `deleteSession`/`removeAgent`) from `@herdctl/core`'s index (add to
  docs/INTEGRATION.md gap list). (b) Session rename skipped (see above). (c) Deleting a
  project does NOT delete its sessions' Claude transcripts under `~/.claude/projects/`
  (they're orphaned but harmless, and unreachable once the project dir/keeper are gone);
  could be added to the delete path later if desired. (d) No Docker isolation change —
  out of scope here.

- 2026-06-21 — Sub-agent (finalize / redeploy upgrade + clean-slate seed + live verify):
  **DONE. UPGRADED SITE IS LIVE AND HEALTHY at https://projects.valfenda.net. No
  rollback needed.** Shipped the latest `main` (commit `5824e7a` — project/chat delete,
  edit metadata, self-hosted fonts, polish), wiped the test junk, seeded Ed's 4 real
  projects, and proved the live upgrade end-to-end in a real browser.

  **TASK A — redeploy with rollback safety (DONE):**
  - **Rollback snapshot**: `cp -a /opt/paddock /opt/paddock.bak` (251M, includes the
    prior working dist + node_modules) BEFORE touching anything. **RETAINED** as a
    safety net (17G free on the LXC; cheap insurance for a live service).
  - **Shipped** the working tree via `tar czf - … | ssh projects 'tar xzf - -C /opt/paddock'`
    (rsync still absent on the LXC). Excluded node_modules/.git/dist/docs(screenshots)/
    playwright. Extracted OVER `/opt/paddock`, **preserving the existing node_modules**
    because `package-lock.json` is byte-identical to the deployed one (sha256
    `caedc7f9…` both sides) → **deps unchanged, `npm install` correctly SKIPPED**.
  - **Built BEFORE restart**: `npm run build` on the LXC → server `tsc` + web `vite`
    both clean (web bundle 409KB/127KB gzip). New `dist/fonts/{inter,jetbrains-mono}-latin.woff2`
    now present; built `index.html` has **0** googleapis/gstatic refs (was 2).
  - **Restarted** `paddock.service`. **Health (LXC)**: `/api/health`→200 `{ok:true}`,
    `/api/projects`→200, `/fonts/inter-latin.woff2`→**200 font/woff2**,
    `/fonts/jetbrains-mono-latin.woff2`→**200 font/woff2**, `/`→200 text/html.
    **Health (laptop, HTTPS)**: same all-200, valid LE cert `CN=projects.valfenda.net`.
    Build succeeded + every check passed → **rollback path never exercised**.

  **TASK B — clean slate + seed real projects (DONE):**
  - **Deleted** the two test projects via the new `DELETE /api/projects/:slug`
    (`deploy-smoke`, `live-verify-14043`) → gone from `/api/projects`, their
    `keeper-*` agents gone from `/api/fleet`, dirs removed from
    `/var/lib/paddock/projects/`. Fleet dropped to just `scratch`.
  - **Seeded** 4 real projects via `POST /api/projects` (201 each), metadata-only,
    kebab-case slugs, each with its keeper agent auto-registered, **chats empty**:
    - `garage-water-heater` — Garage Water Heater — [home, plumbing]
    - `multi-zone-ac` — Multi-Zone AC — [home, hvac]
    - `garden-irrigation` — Garden Irrigation — [garden]
    - `uk-tv-media` — UK TV / Media — [media]
    Final fleet = `scratch` + the 4 `keeper-*`. Grid shows exactly these 4, no junk.

  **TASK C — live verify + screenshots (DONE, 4/4 green):**
  - New `scripts/live-final-verify.mjs` (reuses the proven e2e selectors) drove a real
    Chromium against the LIVE HTTPS URL: (1) landing renders all 4 seeded projects, no
    junk; (2) opened "Garage Water Heater"; (3) New Chat → sent "In one sentence, what
    would you want to know to help plan replacing a garage water heater?" → **a real
    streamed Claude reply rendered** ("I'd want to know: What are your current setup
    details — fuel type (gas/electric/propane), tank size, age… budget… local code
    requirements?"), session `d023ae8a-…` saved; (4) **0 Google-Fonts requests live**,
    body font resolves to Inter. Screenshots: `docs/screenshots/live-final-{landing,
    project,chat}.png`. The test chat was then **deleted** via the API so the landing is
    clean with empty projects (Ed starts the real chats). Max OAuth used (no API-key fallback).
  - **No infra regression**: `paddock.service` active + enabled-on-boot;
    `devbox.valfenda.net`→200. `/opt/paddock.bak` retained (noted above).

  **Honest notes:** (a) deployed commit is `5824e7a` (current `main` HEAD; clean tree —
  nothing uncommitted shipped except, locally, the new `scripts/live-final-verify.mjs`,
  which was NOT shipped to the LXC). (b) Keeper agents still run WITHOUT Docker isolation
  (acceptEdits + denied dangerous bash) — unchanged, documented follow-up. (c) Orphaned
  Claude transcripts from the deleted test projects may linger under the LXC's
  `~/.claude/projects/` but are unreachable/harmless. (d) Rollback `/opt/paddock.bak`
  left in place — `rm -rf /opt/paddock.bak` on the LXC to reclaim 251M once confident.

- 2026-06-21 — Sub-agent (backend: overview + sweep engine, preload, file content,
  pins — issues #1/#2/#3/#4/#6): **DONE + LIVE-VALIDATED (9/9 green).** Built on the
  existing server; no rewrites. **typecheck + build clean** (server tsc, web tsc -b +
  vite). Pushed to `main`.

  **What I built:**
  - **Overview + sweep engine (#2 + #6) — the headline.** New `packages/server/src/sweep.ts`
    (`SweepService`). After a successful USER chat turn, `ws.ts` (at the `chat:complete`
    success path, non-scratch only) calls `sweep.enqueue(slug)`. Guard rails, all proven:
    (a) **per-project coalescing debounce** — at most one sweep per project per
    `PADDOCK_SWEEP_MIN_INTERVAL_MS` (default 5 min); bursts collapse into one trailing
    sweep via a single per-slug timer. (b) **skip if no new activity** — a per-project
    watermark (max keeper-session mtime + last-swept time) persisted in
    `<dataDir>/sweep-state.json` (survives restarts); a sweep whose newest session mtime
    isn't past the watermark is skipped. (c) **no recursion** — sweeps trigger a dedicated
    agent OUT OF BAND (`HerdctlService.runSweeper`, `triggerType:"manual"`, fresh session),
    never via the WS user-chat path, so a sweep can't enqueue another. The sweeper is a
    per-project **lightweight curator agent** (`sweeper-<slug>`, model
    `claude-haiku-4-5-20251001` — verified current via the claude-api skill — tools
    Read/Write/Glob/Grep only, Bash/Edit/WebFetch denied, acceptEdits, max_turns 20),
    registered once like the keepers (generated yaml + reload; removed on project delete).
    The curation prompt hands it a digest of recent transcripts + current OVERVIEW.md +
    recent CHANGELOG and tells it to (1) **rewrite OVERVIEW.md** = synthesized current
    state for an LLM to read at chat start (replaced), and (2) **append ONE dated bullet
    to CHANGELOG.md** (append-only). Sweep failures are non-fatal (logged, never break
    chat). `ProjectStore` gained `readOverview/writeOverview/overviewExists`; the project
    DTO gained `hasOverview`. New `GET /api/projects/:slug/overview` (raw OVERVIEW.md).
  - **Context preload (#1).** `chat:send` payload gained `preloadContext?: boolean`. When
    the chat is NEW (sessionId null) AND the flag is true AND OVERVIEW.md exists, the
    server prepends it as `"<project-context>\n…\n</project-context>\n\nMy request:\n…"`.
    No-op for scratch / resumes / missing overview.
  - **File content endpoint (#3).** `GET /api/projects/:slug/files/:name` →
    `{ name, kind: "markdown"|"html"|"text", content }` (kind from extension; path-traversal
    guarded via `ProjectStore.readFile`). 404 missing, 400 traversal.
  - **Pins (#4).** `ProjectYaml` + DTO gained `pinned: string[]` (default []).
    `PUT /api/projects/:slug/pins {file}` (validates existence, dedupes) and
    `DELETE /api/projects/:slug/pins/:file` (URL-encoded). Persisted to project.yaml.

  **LIVE VALIDATION (Max OAuth, claude CLI 2.1.167, dot-free temp PADDOCK_DATA_DIR,
  PORT 4055, `PADDOCK_SWEEP_MIN_INTERVAL_MS=8000` to exercise debounce fast — same code
  path as the 5-min default; token sourced into env, never printed):**
  - Created "Sweep Demo" → new chat (no preload) asked it to write `plan.md` + `diagram.html`
    → keeper wrote both (Write tool_calls), turn success. ✓
  - A sweep **fired** (`sweeper-sweep-demo` job, distinct from `keeper-sweep-demo`):
    `OVERVIEW.md` created (synthesized state) and ONE dated bullet appended to `CHANGELOG.md`.
    DTO `hasOverview` flipped to true; `/overview` matched the file. `sweep-state.json`
    watermark persisted. ✓
  - **Debounce**: two rapid resumed turns within the interval → exactly **1** OVERVIEW
    rewrite (coalesced, not 2). Across 4 user turns the log showed 3 `sweep: completed`
    and **0 recursive** sweeps (count matched activity windows). ✓
  - **Skip-if-no-activity**: isolated test pre-seeding a future watermark → enqueue logged
    `sweep: skipped (no new activity)` and did NOT rewrite OVERVIEW.md. ✓
  - **Preload**: NEW chat with `preloadContext:true` + vague question ("what files exist?")
    → reply correctly listed `plan.md` and `diagram.html` from the injected overview,
    without reading files. ✓
  - **Files**: `/files/plan.md`→kind:markdown, `/files/diagram.html`→kind:html, missing→404,
    `../../etc/hosts`→400. **Pins**: pinned both (deduped on repeat), nonexistent→400,
    project.yaml `pinned` persisted, unpin→200 leaving one. ✓
  Server stopped; temp data + the test Claude transcript removed; scratch scripts deleted.

  **Contract for the frontend agent:** full delta in `docs/CONTRACT-v2.md`. Summary:
  DTO `+hasOverview:boolean` `+pinned:string[]`; `chat:send` `+preloadContext?:boolean`
  (new-chat overview inject); new `GET /:slug/overview`, `GET /:slug/files/:name`
  (`{name,kind,content}`), `PUT /:slug/pins {file}`, `DELETE /:slug/pins/:file`.

  **Honest notes / rough edges:** (a) **No push for sweeps** — they run out of band with
  no WS event; the UI must pull (`GET /:slug`, `/overview`, `/changelog`) to reflect a
  fresh sweep. A sweep-push WS channel is a clean future enhancement. (b) The sweeper is
  **one agent per project** (not a single shared sweeper) because herdctl binds
  `working_directory` per-agent and `TriggerOptions` has no cwd override — so each project
  needs its own cwd-bound sweeper. Doubles the agent count; acceptable, and removed on
  project delete. (c) The sweeper runs **without Docker isolation** like the keepers
  (acceptEdits, Bash denied) — same documented follow-up. (d) Sweep min interval is 5 min
  by default; the live test used 8s via env to exercise coalescing quickly — the prod
  default is unchanged. (e) Not yet deployed to the LXC (code + push only, per scope);
  redeploy is a separate step.
