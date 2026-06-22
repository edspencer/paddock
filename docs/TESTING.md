# Testing paddock

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

### The test-app factory

`startTestApp(opts)` (`packages/server/test/helpers/app.ts`) creates a temp
`HOME` + data dir, prepends `test/bin` to `PATH`, optionally `git init`s the
projects root, writes the fake script, and calls `buildApp({ serveStatic:false })`.
Returns the wired app + a `teardown()` that stops the fleet, restores env, and
removes the temp dir. WS tests use `listen()` + `connectWs()`
(`test/helpers/ws.ts`), a tiny `ws` client with `mark()` + `waitFor({ from })`
so a shared socket can scope each turn's events.

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

- **Resume continuity after promote** (harness finding). After promoting a
  one-off chat into a project, the chat lists + hydrates under the project and
  its job records are re-attributed, but **resuming it forks a fresh session**
  (the codeword is lost). Root cause: herdctl's JobExecutor only honors
  `--resume` when the agent has a stored session-info file
  (`.herdctl/sessions/<agent>.json`); `promoteScratchSession` re-homes the
  transcript + rewrites job records but never writes the keeper's session-info,
  so the keeper has none and the runtime starts fresh. Verified fix:
  writing a keeper session-info file on promote makes resume continue the same
  session (codeword recalled). `promote.test.ts` asserts the *current* (forking)
  behavior with a comment, so fixing the gap will flip that assertion. This is
  the resume half of the #20 saga the design doc calls out — the harness caught
  it, as intended.
- `reattributeSession` / `writeAdoptionJob` are covered end-to-end via
  `promote.test.ts` (they're private). A direct unit test would need a small
  export seam; left as a follow-up.
- The post-turn **sweeper** runs during integration chats but errors
  ("sweeper output missing OVERVIEW/CHANGELOG markers") because the fake doesn't
  emit the sweeper's marker format. It's out-of-band and non-fatal (logged,
  doesn't affect chat), so it's left unscripted. Scripting a marker-shaped
  sweeper reply + asserting OVERVIEW.md/CHANGELOG.md curation is a good
  follow-up (would let `sweep.ts` be covered).
- E2E covers the happy paths; error states (offline socket, failed turn,
  validation errors in-browser), model-picker, context-meter, file pins/tabs,
  and the git UI are not yet driven from the browser.
- `github-auth.ts` (device flow) is untested — it needs `fetch` mocking; a unit
  test with a stubbed `fetch` is a clean follow-up.
- No coverage thresholds wired up yet (herdctl uses 85%); add
  `@vitest/coverage-v8` gating once the suite is broader.
