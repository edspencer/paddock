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

- **Server** (`packages/server/test/unit/`, node env):
  - `projects.test.ts` — slugify, fileKind, create/get/list/update, the
    group/area + model round-trips, pin/unpin, appendChangelog, file reads +
    traversal guard, overview, remove.
  - `models.test.ts` — the model list, defaults, lookups.
  - `transcripts.test.ts` — `encodeProjectDir`, `ensureProjectChats` incl. the
    symlink-healing + real-dir-migration branches (against a temp `CLAUDE_HOME`).
  - `github-auth.test.ts` — the GitHub OAuth **device flow** with a mocked
    global `fetch`: `clientId`/`status`, `startDeviceFlow` (happy + non-ok +
    malformed), `pollDeviceFlow` (pending / slow_down / authorized / error /
    non-JSON-body, the 0600 token file + login lookup), `token`/`disconnect`,
    and the cache.
  - `git.test.ts` — `GitService` against real temp repos: not-a-repo guards, a
    configured **bare-origin remote** + push/ahead-behind, single-file diff, the
    unborn-branch diff fallback, rename-prefix stripping, commit no-op/error.
  - `sweep.test.ts` — `SweepService` with stubbed herdctl/projects: parse +
    write, coalescing a burst into one sweep, skip-no-activity + the persisted
    watermark, the unparseable-output retry (watermark not advanced),
    sweeper-failure + project-deleted drops, `stop()`.
- **Web** (`packages/web/src/**/*.test.{ts,tsx}`, jsdom + @testing-library/react):
  - `lib/areas.test.ts`, `lib/format.test.ts`.
  - `components/StatusPill`, `components/TagPill`.
  - `routes/ProjectsGrid.test.tsx` — area-section grouping/order/counts,
    collapse + localStorage, Inbox, tag-filter mode.
  - The New / Edit / Promote modals — validation + the exact request payload they
    build (api client mocked).

Run just one layer:

```
npm run test:server          # all server tests (unit + integration)
npm run test:web             # all web tests
npm run test -w packages/server -- test/unit   # server unit only
```

## Layer 2 — server integration (Vitest + fake claude)

Boots the **real** Fastify app (`buildApp()`), the **real** `@herdctl/core`
FleetManager + CLI runtime, the **real** transcript/session machinery — against a
temp data dir, with the fake `claude` first on `PATH`. Files:
`packages/server/test/integration/`.

- `projects-crud.test.ts` — REST CRUD, keeper registration in fleet status,
  pins, 404/409/400 paths.
- `chat.test.ts` — a chat turn streamed over **WebSocket**, transcript written +
  discovered, history hydration on reload, context-usage readback, and **resume
  continuity** (set a codeword, resume, recall it).
- `ws.test.ts` — WS transport edge cases: ping/pong, invalid-JSON + unknown +
  malformed messages → `chat:error`, the `onChatSend` catch path (unknown
  project), `preloadContext` (OVERVIEW.md injection for a new chat, no-op for
  scratch / no-overview), per-chat **model override** (valid → ensureKeeper/
  ScratchModel; unknown → fallback), `chat:tool_call` + `chat:message_boundary`
  (via the fake's `[[TOOL]]` / `[[BOUNDARY]]` directives), `chat:cancel`, the
  usage/model surfaced on `chat:complete`, and the legacy `target` alias.
- `routes.test.ts` — REST coverage gaps: rename + delete chat (project +
  scratch), pins (missing-file / traversal-guard / dedupe), the `/context`
  endpoints (project + scratch, with + without usage), GET `/overview` +
  `/changelog` + `/files/:name`, the thin `POST …/chats` echo, `/api/fleet`,
  `/api/git/push`, git-route 404s, and the **GitHub device-flow endpoints**
  (`connect`/`poll`/`disconnect`) driven with a mocked `fetch`.
- `sweep.test.ts` — the post-turn curation sweep runs end-to-end: a project turn
  enqueues a sweep, the (tool-less) sweeper returns marker-shaped text (via the
  fake), `SweepService` parses it and writes `OVERVIEW.md` + appends a
  `CHANGELOG.md` bullet; scratch turns are NOT swept. Uses
  `startTestApp({ sweepIntervalMs: 0 })` so the trailing sweep fires immediately.
- `app-static.test.ts` — `buildApp({ serveStatic:true })`: serving `index.html`
  at `/` + the SPA fallback, the JSON 404 for unknown `/api` paths, and the
  API-only degrade when the web dist is missing.
- `promote.test.ts` — promote a one-off chat → project (#20): lists under the
  project, history hydrates, job re-attribution, transcript cwd-rewrite. (See
  "Known gaps" for resume-after-promote.)
- `git.test.ts` — status/diff/commit against a real temp git repo, and the
  `repo:false` path when the store isn't a repo.

### The fake-claude harness (`test/bin/claude`)

herdctl's CLI runtime spawns `claude` from `PATH` and then **watches the session
JSONL file** it writes (it does *not* read the process's stdout). So the fake:

1. Parses the flags herdctl passes (`-p`, `--permission-mode`, `--model`,
   `--system-prompt`, `--allowedTools`, `--resume <id>`, …) and reads the prompt
   from **stdin**.
2. Computes the session dir the same way herdctl does —
   `~/.claude/projects/<cwd-with-every-non-alnum→'-'>/` (via `os.homedir()`). For
   paddock that encoded path is a symlink to `<projectDir>/.chats`, so writes
   land in the project.
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

Flows covered (`happy-path.spec.ts`): create a project (pick an area) → land in
it; send a chat and watch it stream, reload and see history; collapse an area
section; filter by a domain tag; promote a one-off chat into a project.

Artifacts (screenshots on failure, traces/videos on retry) go to the run's temp
dir, never the repo.

### Live mode (`npm run test:e2e:live`)

Sets `PADDOCK_TEST_LIVE=1`, which makes `server.mjs` use the **real** `claude` +
the Max OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) and the real `~/.claude`. For
occasional smoke runs only — manual/nightly, never CI. Default is always the
fake.

## A production change this work required

`@herdctl/core` 5.13's config loader **drops `runtime` from fleet-level
`defaults`** (it's only an agent-level field there). paddock relied on
`defaults.runtime: cli`, so without a fix every agent silently fell back to the
**SDK** runtime (which needs an API key) instead of the CLI/Max runtime. We now
set `runtime: "cli"` **explicitly on each agent** (keeper/sweeper/scratch) in
`herdctl.ts`. This both (a) makes the fake-claude/CLI path actually run and (b)
matches paddock's documented "CLI (Max plan)" intent. `index.ts` was also split
into a `buildApp()` factory (`app.ts`) so tests can boot the app without binding
a port or installing signal handlers — a pure seam, no behavior change.

## Known gaps / TODO for follow-up agents

- **Resume continuity after promote — FIXED** (the harness caught this, as
  intended). After promoting a one-off chat into a project it used to fork a
  fresh session on resume (codeword lost). Root cause was in herdctl's
  JobExecutor: it dropped an explicit `--resume` when the agent had no stored
  session-info file, so a keeper resuming an adopted session started fresh. Fixed
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
- E2E covers the happy paths; error states (offline socket, failed turn,
  validation errors in-browser), model-picker, context-meter, file pins/tabs,
  and the git UI are not yet driven from the browser.
- `index.ts` (the process bootstrap: bind a port + signal handlers) and
  `spike.ts` (a dev-only `@herdctl/core` exploration script, excluded from the
  production build) are intentionally left at 0% — neither is server logic worth
  a test. Excluding them, the meaningful `src/**` coverage is ~93% stmts.
- Server coverage is now ~90% stmts / 84% branch over all `src/**` (~93% / ~84%
  excluding index/spike), up from ~72% / ~67%. Wiring a
  `@vitest/coverage-v8` threshold gate (herdctl uses 85%) is the natural next
  step now that the suite is broad.
