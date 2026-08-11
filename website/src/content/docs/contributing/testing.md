---
title: "Testing"
description: "How Paddock is tested: unit, integration, and end-to-end."
---

Three layers, all runnable with **zero Anthropic calls** thanks to a fake
`claude` binary. See `docs/DESIGN-testing.md` for the rationale; this file is the
how-to.

```
npm test            # vitest: server unit + server integration + web unit/component
npm run test:e2e    # playwright: Chromium against the built SPA + real server + fake claude
npm run test:e2e:live  # same, but the REAL claude + Max token (gated; manual only)
```

## Layer 1 — unit (Vitest, fast, no network)

Pure-logic + component tests. No server, no fleet, no claude.

The suite is too large to enumerate file-by-file and stay accurate, so this is the
shape rather than a list. As of v0.66.2:

- **Server** (`packages/server/test/unit/`, node env) — **100 files**. Broadly:
  project CRUD and slugging, path containment and the system-path denylist, the
  config resolver and every `PADDOCK_*` precedence rule, instance-config validation,
  transcripts (`encodeProjectDir`, `ensureProjectChats`, and the `transcripts: host`
  symlink target), the `claude:` sharing levers, MCP-server declaration and
  allowlisting, the self-MCP tool surface and its gates, `SweepService`, `GitService`
  against real temp repos, the GitHub OAuth device flow with a mocked `fetch`,
  schema-version guards and the turn interlock.
- **Web** (`packages/web/src/**/*.test.{ts,tsx}`, jsdom + @testing-library/react) —
  **72 files**: `lib/` helpers, individual components, the route-level grids and
  panes, and the modals (validation plus the exact request payload each builds,
  with the api client mocked).

To see the current list, `ls packages/server/test/unit/` — the filenames map to the
`src/` module they cover.

Run just one layer:

```
npm run test:server                         # all server tests (unit + integration)
npm run test:web                            # all web tests
npm run test:unit -w packages/server        # server unit only
npm run test:integration -w packages/server # server integration only
```

## Layer 2 — server integration (Vitest + fake claude)

Boots the **real** Fastify app (`buildApp()`), the **real** `@herdctl/core`
FleetManager + CLI runtime, the **real** transcript/session machinery — against a
temp data dir, with the fake `claude` first on `PATH`. Files:
`packages/server/test/integration/` — **58** of them at v0.66.2. A representative
slice, to show what this layer is for:

- `projects-crud.test.ts` — REST CRUD, agent registration in fleet status,
  pins, 404/409/400 paths.
- `chat.test.ts` — a chat turn streamed over **WebSocket**, transcript written +
  discovered, history hydration on reload, context-usage readback, and **resume
  continuity** (set a codeword, resume, recall it).
- `ws.test.ts` — WS transport edge cases: ping/pong, invalid-JSON + unknown +
  malformed messages → `chat:error`, the `onChatSend` catch path (unknown
  project), `preloadContext` (OVERVIEW.md injection for a new chat, no-op when
  there is no overview), per-chat **model override** (valid →
  `ensureAgentModel`; unknown → fallback), `chat:tool_call` + `chat:message_boundary`
  (via the fake's `[[TOOL]]` / `[[BOUNDARY]]` directives), `chat:cancel`, the
  usage/model surfaced on `chat:complete`, and the legacy `target` alias.
- `routes.test.ts` — REST coverage gaps: rename + delete chat (incl.
  unknown-slug 404s), pins (missing-file / traversal-guard / dedupe), the
  `/context` endpoints (with + without usage), GET `/overview` +
  `/changelog` + `/files/:name`, the thin `POST …/chats` echo, `/api/fleet`,
  `/api/git/push`, git-route 404s, and the **GitHub device-flow endpoints**
  (`connect`/`poll`/`disconnect`) driven with a mocked `fetch`.
- `sweep.test.ts` — the post-turn curation sweep runs end-to-end: a project turn
  enqueues a sweep, the (tool-less) sweeper returns marker-shaped text (via the
  fake), `SweepService` parses it and writes `OVERVIEW.md` + appends a
  `CHANGELOG.md` bullet. Uses
  `startTestApp({ sweepIntervalMs: 0 })` so the trailing sweep fires immediately.
- `app-static.test.ts` — `buildApp({ serveStatic:true })`: serving `index.html`
  at `/` + the SPA fallback, the JSON 404 for unknown `/api` paths, and the
  API-only degrade when the web dist is missing.
- `promote.test.ts` — promote a one-off chat → project (#20): lists under the
  project, history hydrates, job re-attribution, transcript cwd-rewrite. (See
  "Known gaps" for resume-after-promote.)
- `git.test.ts` — status/diff/commit against a real temp git repo, and the
  `repo:false` path when the store isn't a repo.

The other ~50 follow the same pattern against the real app: the queue and its
slot-versioning frames, sub-agent sidechain and background rehydration, the turn
interlock on delete/revert/promote, adopt + unadopt, declared MCP servers (including
the `--mcp-config` argv exposure under `driveMode: batch`), and the instance-config
routes. `ls packages/server/test/integration/` for the current set.

### The fake-claude harness (`test/bin/claude`)

> **The harness pins `batch` on purpose.** A fake `claude` on `PATH` is only
> reachable from the **CLI** runtime, and Paddock's default drive mode is
> `session` — which routes turns through `openChatSession` → the **SDK** runtime,
> which spawns the SDK's own bundled `claude` and would never see the stub. So
> `test/e2e/server.mjs:127` sets `PADDOCK_DRIVE_MODE=batch` in fake mode
> (live mode leaves the default alone). The E2E suite therefore exercises the CLI
> runtime, **not** the runtime a real chat uses.

herdctl's CLI runtime spawns `claude` from `PATH` and then **watches the session
JSONL file** it writes (it does *not* read the process's stdout). So the fake:

1. Parses the flags herdctl passes (`-p`, `--permission-mode`, `--model`,
   `--system-prompt`, `--allowedTools`, `--resume <id>`, …) and reads the prompt
   from **stdin**.
2. Computes the session dir the same way herdctl does —
   `<claudeHome>/projects/<cwd-with-every-non-alnum→'-'>/`, resolving
   `<claudeHome>` from `CLAUDE_CONFIG_DIR` and only falling back to `~/.claude`
   (`claudeHome()` in `test/bin/claude`). That fallback is *not* the paddock case:
   paddock runs against its own home, so the dir is
   `<dataDir>/claude-home/projects/<enc>` — and that encoded path is the symlink to
   `<projectDir>/.chats`, so writes land in the project. Hard-coding `~/.claude`
   here writes transcripts somewhere herdctl is not watching, and the turn dies 60s
   later on "Timeout waiting for new session file".
3. Writes a **real `<sessionId>.jsonl` transcript** with the exact line shapes
   `@herdctl/core`'s `jsonl-parser` + the `@herdctl/chat` translator consume:
   - `user`  → `{type:"user", message:{role:"user", content:"…"}, sessionId,
     cwd, timestamp}` (first line is never `isSidechain:true`, so discovery
     keeps it).
   - `assistant` → `{type:"assistant", message:{id, role:"assistant", model,
     content:[{type:"text", text:"…"}], usage:{…}}, sessionId, cwd}`.
   - `result` → `{type:"result", subtype:"success", is_error:false, session_id,
     result:"…", usage:{…}}` (ends the watcher loop, marks success).
   Lines are appended with small gaps so the chokidar watcher streams them.
4. **New session** → mints a UUID, writes `<uuid>.jsonl`. **`--resume <id>`** →
   appends to `<id>.jsonl` and reads the prior transcript so it can answer
   continuity questions.

**Scripted replies** (deterministic):

- `PADDOCK_FAKE_SCRIPT` → a JSON file path mapping `prompt → reply` (exact match).
  The integration helper writes one from `startTestApp({ script })`.
- Built-in rules: "the codeword is X" / "what was the codeword?" (continuity),
  and a default `Acknowledged: <prompt>` echo so the E2E can assert streamed text.

**Prompt directives + sweeper replies** (added for the ws/sweep coverage work —
each is OPT-IN; a prompt with none of these is handled exactly as before):

- `[[TOOL]]` anywhere in the prompt → the fake emits a paired `tool_use`
  (assistant) + `tool_result` (user) around its reply, so `@herdctl/chat`'s
  translator surfaces a `chat:tool_call` event (exercises ws.ts's `onToolCall`).
- `[[BOUNDARY]]` → the fake emits a **second** assistant text block after the
  first, so the translator fires `onBoundary` → `chat:message_boundary`. Note: a
  brand-new session occasionally races the runtime's watcher on its first read,
  so the `ws.test.ts` boundary case sends this turn as a **resume** of an
  existing session (the transcript file already exists, watcher attaches
  reliably).
- **Sweeper curation prompts** (detected by the literal `<<<OVERVIEW>>>` the
  sweeper system/user prompt asks for) → the fake returns a marker-shaped reply
  (`<<<OVERVIEW>>> … <<<CHANGELOG>>> … <<<END>>>`) so `SweepService` can parse it
  and write `OVERVIEW.md`/`CHANGELOG.md`. The exact text is overridable via
  `PADDOCK_FAKE_SWEEP` (a file path whose contents become the sweeper reply).
  This closes the prior "sweeper output missing markers" gap — the sweep now
  runs cleanly in integration instead of erroring out of band.

### The test-app factory

`startTestApp(opts)` (`packages/server/test/helpers/app.ts`) creates a temp
`HOME` + data dir, prepends `test/bin` to `PATH`, optionally `git init`s the
projects root, writes the fake script, and calls `buildApp({ serveStatic:false })`.
Returns the wired app + a `teardown()` that stops the fleet, restores env, and
removes the temp dir. Options: `script` (the fake-script map), `gitRepo` (init a
git repo at the projects root), and `sweepIntervalMs` (sets
`PADDOCK_SWEEP_MIN_INTERVAL_MS`; pass `0` to make the post-turn sweep fire on the
next tick instead of waiting the 5-min default). WS tests use `listen()` +
`connectWs()` (`test/helpers/ws.ts`), a tiny `ws` client with `mark()` +
`waitFor({ from })` so a shared socket can scope each turn's events, plus
`sendRaw(text)` to push a non-JSON frame (for the invalid-JSON path).

## Layer 3 — E2E (Playwright + fake claude)

`test/e2e/` drives Chromium against the **built** SPA + a **real** server with the
fake claude. `test/e2e/server.mjs` boots `packages/server/dist/index.js` serving
`packages/web/dist`, against a throwaway HOME + data dir, fake `claude` on PATH.
`playwright.config.ts` runs it via `webServer` and waits on `/api/health`.

**You must build first**: `npm run build` (server + web), then `npm run test:e2e`.

**The layer is 22 specs across four Playwright projects, against two servers.** The
config (`test/e2e/playwright.config.ts`) declares:

| Project | Specs | Viewport | Server |
|---|---|---|---|
| `chromium` | everything except the git and mobile specs | Desktop Chrome | `4317` |
| `chromium-git` | `journey-git-*.spec.ts` | Desktop Chrome | `4318` |
| `mobile` | `journey-mobile.spec.ts` | Pixel 5 (`isMobile` + `hasTouch`) | `4317` |
| `mobile-git` | `journey-mobile-git.spec.ts` | Pixel 5 | `4318` |

The two servers exist because git-repo detection is cached process-wide, so a
repo-backed and a non-repo run cannot share one. Both ports derive from
**`PADDOCK_E2E_PORT`** (default `4317`; the git server is always that `+ 1`) — override
it if `4317`/`4318` are taken. Each server gets its own temp data dir.

An orphaned fixture server from a previous run is **no longer the normal reason** to
need that override. Since v0.67 the launcher watches its own ancestry and
self-terminates when the run above it dies, so an aborted run stops leaking a live
server that the next run then attaches to via `reuseExistingServer`. Two facts hold
that fix up, and both are worth knowing before touching `test/e2e/server.mjs`:

- **Watching `process.ppid` alone never fires.** Playwright runs the launcher as
  `/bin/sh -c node test/e2e/server.mjs`, and that shell does not `exec` it — the
  parent survives indefinitely. The death to detect is the **grandparent's**. (Both
  are checked, since a shell that *did* exec would leave the runner as the direct
  parent, and both are compared against the pid captured at boot rather than
  against `1`, which a container can legitimately be started by.)
- **The server spawn must not be `detached: true`.** Playwright spawns the
  `webServer` command detached and kills its own process group on a clean run; a
  detached child escapes that kill and survives every ordinary run. Signal handlers
  are not a substitute — on the abort path the launcher is never signalled at all.

The `mobile` projects reuse the same Chromium install, so a phone-sized run costs no
extra browser download in CI.

`happy-path.spec.ts` is the original smoke run — create a project (pick an area) → land
in it; send a chat and watch it stream, reload and see history; collapse an area
section; filter by a domain tag; promote a root chat into a project. The 20
`journey-*` specs are the real coverage: chat, errors, files, git changes, GitHub,
attachments + queue, sub-agents, lifecycle, preload, remount hydration, the root
workspace, tags, theme, turn notices, home attention, the fleet readout, project
view, landing, and the two mobile journeys.

The twenty-second spec is the odd one out. `orphan-watchdog.spec.ts` runs under
`chromium` like the journeys, but it needs **no port, no build and no browser** — it
uses no `page` at all. It exercises the launcher's orphan watchdog against the real
process topology (launcher → detached `sh -c` → harness → non-detached child), with
a sleeper standing in for the Paddock server, and it reads liveness from
`/proc/<pid>/stat`'s `State:` rather than `process.kill(pid, 0)` — a zombie still
accepts signals, so a `kill(pid, 0)` probe would fail against a watchdog that works
perfectly.

Artifacts (screenshots on failure, traces/videos on retry) go to the run's temp
dir, never the repo. The HTML report lands there too, under `<temp>/report`.

:::note[Don't go looking for the report in a failed CI run]
CI has an upload step for the Playwright report, but it points at
`test/e2e/playwright-report/` — a path the reporter never writes to — with
`if-no-files-found: ignore`, so it is a silent no-op on every failed E2E run. Reproduce
locally to get a report. Tracked as
[#774](https://github.com/edspencer/paddock/issues/774); the workflow is what's wrong
here, not the config.
:::

### Live mode (`npm run test:e2e:live`)

Sets `PADDOCK_TEST_LIVE=1`, which makes `server.mjs` use the **real** `claude` +
the Max OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) and the real `~/.claude`. For
occasional smoke runs only — manual/nightly, never CI. Default is always the
fake.

## A production change this work required

`@herdctl/core` 5.13's config loader **drops `runtime` from fleet-level
`defaults`** (it's only an agent-level field there). paddock relied on
`defaults.runtime: cli`, so without a fix every agent silently fell back to the
**SDK** runtime. We now set `runtime: "cli"` **explicitly on each agent**
(keeper/sweeper) in `herdctl.ts`, which is what makes the fake-claude/CLI
path actually run.

> **Scope note.** `runtime` is read only on the one-shot `trigger()` path —
> `openChatSession` hard-codes the SDK runtime — so these lines govern the **sweeper**
> and any turn resolved to **`driveMode: batch`**. They do **not** make a real chat a
> `claude -p` subprocess; the default `session` mode drives it on the SDK. And note a
> **trigger is not automatically a `trigger()` call**: a scheduled or event trigger
> resolves its drive mode exactly like a chat (project override, else the instance
> default), so on the default `session` it goes through `openChatSession` too. Only
> the sweeper is unconditional — several source comments still say otherwise, tracked
> as [#771](https://github.com/edspencer/paddock/issues/771). The original note here
> also framed this as a Max-vs-API-key choice, which was wrong: either credential works
> on either runtime.

`index.ts` was also split into a `buildApp()` factory (`app.ts`) so tests can boot the
app without binding a port or installing signal handlers — a pure seam, no behavior
change.

## Known gaps / TODO for follow-up agents

- **Resume continuity after promote — FIXED** (the harness caught this, as
  intended). After promoting a one-off chat into a project it used to fork a
  fresh session on resume (codeword lost). Root cause was in herdctl's
  JobExecutor: it dropped an explicit `--resume` when the agent had no stored
  session-info file, so an agent resuming an adopted session started fresh. Fixed
  upstream in **@herdctl/core 5.13.1 (herdctl#263)** — the executor now adopts a
  caller-provided resume when the transcript exists in the agent's working dir.
  `promote.test.ts` now asserts the resumed turn continues the **same** session
  and recalls the codeword.
- `reattributeSession` / `writeAdoptionJob` are covered end-to-end via
  `promote.test.ts` (they're private). A direct unit test would need a small
  export seam; left as a follow-up.
- The post-turn **sweeper — NOW COVERED**. The fake emits a marker-shaped
  sweeper reply (see "Prompt directives" above), so `sweep.test.ts` drives the
  real curation end-to-end (OVERVIEW.md replaced, a CHANGELOG.md bullet
  appended), and `test/unit/sweep.test.ts` covers the coalescing / skip /
  watermark / retry branches. The sweep no longer errors out of band in
  integration runs.
- `github-auth.ts` (device flow) — **NOW COVERED** via `test/unit/github-auth.test.ts`
  with a mocked global `fetch` (the device-code + token + user endpoints). Found
  + fixed a bug along the way: `pollDeviceFlow` called `res.json()` with no
  `res.ok`/parse guard, so a non-JSON token-endpoint response (gateway 5xx) threw
  an unhandled `SyntaxError` instead of returning `{ status: "error" }`
  (**issue #21**, fixed; regression test added).
- `reattributeSession` / `writeAdoptionJob` are covered end-to-end via
  `promote.test.ts` (they're private). A direct unit test would need a small
  export seam; left as a follow-up.
- **E2E is no longer happy-path-only.** Error states
  (`journey-errors.spec.ts`), file pins/tabs (`journey-files.spec.ts`) and the git UI
  (`journey-git-changes.spec.ts`, `journey-git-github.spec.ts`,
  `journey-mobile-git.spec.ts`) all have specs now. What is still thin from the
  browser: the model picker and the context meter, which are asserted at the
  component and integration tiers instead.
- **The fake `claude` cannot reach every state.** It is a CLI stub, so the suite that
  uses it exercises the **CLI** runtime, not the SDK runtime a real chat uses — and it
  accepts transcript shapes the real Messages API would reject. Structural soundness
  is what these tests prove; real-API resumability is not verifiable at this tier.
- `index.ts` (the process bootstrap: bind a port + signal handlers) is
  intentionally left at 0% — it isn't server logic worth a test.
- **No coverage figures are quoted here on purpose.** The numbers this page used to
  carry predate roughly 150 added test files and could not be reproduced. Measure it
  yourself when you need it (`npm run test -w packages/server -- --coverage`;
  `@vitest/coverage-v8` is already a devDependency) rather than trusting
  a figure in prose. Wiring a `@vitest/coverage-v8` threshold gate (herdctl uses 85%)
  is still the natural next step.
