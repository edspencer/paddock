# Paddock Test Strategy

Goal: high confidence that paddock keeps working after every change — at the
**server**, **herdctl-integration**, and **UI** levels — without paying for (or
waiting on) real Anthropic calls on every run.

## The core idea: stub the LLM, exercise everything else for real

Paddock's value and its risk both live in the **herdctl integration** — session
discovery, transcript relocation, attribution, resume. Mocking that away (e.g.
injecting a fake `HerdctlService`) would test plumbing we don't worry about and
skip the part that actually bites us (see herdctl#263, the promote-resume saga).

So we stub at the **lowest possible layer: the `claude` binary itself**, and run
the *real* Fastify server, the *real* `@herdctl/core` FleetManager + CLI runtime,
the *real* transcript/session machinery, and the *real* web bundle.

### The fake-claude harness (`test/bin/claude`)

A small executable placed first on `PATH` for the server under test. herdctl's
CLI runtime spawns `claude` from `PATH`, so it spawns ours. The fake:

- Parses the same flags herdctl passes (`--print`, `--output-format stream-json`,
  `--resume <id>`, `--session-id`, cwd, prompt on stdin/args).
- Emits the **stream-json** events `@herdctl/chat`'s translator expects (system
  init → assistant text deltas → result), so the WS streaming path is exercised.
- Writes/append a **real JSONL transcript** to
  `~/.claude/projects/<enc(cwd)>/<sessionId>.jsonl` (matching Claude Code's
  format), so session discovery, history hydration, delete, rename, and **resume**
  all run against real files.
- `--resume <id>`: reads the existing transcript and produces a scripted reply
  that can reference prior turns (so continuity is *testable* — e.g. "what was the
  codeword?" → the value from the earlier turn).
- Deterministic, scripted responses keyed by prompt (a fixture map), so assertions
  are stable.

Net effect: the **entire paddock + herdctl stack runs with zero Anthropic calls** —
fast, free, deterministic, CI-safe. This is the harness that would have caught the
attribution + resume bugs from #20.

### Optional live mode

`PADDOCK_TEST_LIVE=1` swaps the fake for the real `claude` + the Max OAuth token
(`CLAUDE_CODE_OAUTH_TOKEN`) for an occasional smoke run of a *few* tagged tests.
Default is always the fake. Live mode is manual / nightly only.

## Layers

1. **Unit (Vitest, node + jsdom)** — pure logic, no network.
   - server: `projects` (slug/normalize/CRUD/pin/changelog/group round-trip),
     `models`, `transcripts` (encode + `ensureProjectChats` against a temp dir),
     `git` (against a temp git repo), `github-auth` (mocked `fetch`),
     `reattributeSession`/`writeAdoptionJob` (temp jobs dir).
   - web: `areas` (ordering/labels), `format`, and component tests via
     `@testing-library/react` (StatusPill, TagPill, area-section grouping, the
     New/Edit/Promote modals' validation + payloads).

2. **Server integration (Vitest + fake-claude)** — boot the Fastify app in-process
   against a temp data dir and the fake `claude` on PATH; hit REST + WS. Covers
   `routes.ts`, `ws.ts`, `herdctl.ts`: project CRUD, a chat turn (streamed over
   WS), history hydration on reload, **promote a one-off chat → project** (list +
   history + resume continuity), git status/commit.

3. **E2E / browser (Playwright + fake-claude)** — build the web, run the real
   server, drive Chromium: create a project (pick area), chat and watch it stream,
   reload and see history, collapse area sections, filter by tag, promote a one-off
   chat and land in the project. Screenshots on failure.

## Tooling choices

- **Vitest** for unit + server integration — already the herdctl standard
  (consistency), fast, native ESM/TS, jsdom for components.
- **Playwright** (Chromium) for browser E2E — already vendored here; great trace
  + screenshot story.
- **Fake-claude binary** for the LLM stub (above) — preferred over record/replay
  (simpler, deterministic) and over mocking `HerdctlService` (keeps the real
  herdctl integration under test).

## Scripts / CI

```
npm test            # vitest: unit + server integration (fake claude). Fast, every change.
npm run test:e2e    # playwright: browser, real server + fake claude.
npm run test:e2e:live  # playwright with the real claude + Max token (gated; nightly/manual).
```

CI runs `npm test` + `npm run test:e2e` on every change. `test:e2e:live` is
manual/nightly.

## Verifying changes (the whole point)

- **Paddock change:** `npm test && npm run test:e2e` — the stack runs (UI clicked,
  server real, herdctl real, LLM faked).
- **herdctl change:** herdctl's own vitest suite, *plus* bump paddock's
  `@herdctl/core`/`@herdctl/chat` to the candidate and run paddock's integration +
  E2E against it — catches integration regressions (the class of bug behind #20).

## Build-out order

1. Foundation: vitest + playwright config, scripts, jsdom/@testing-library, the
   fake-claude harness, a server test-app factory (`buildApp({ dataDir })`).
2. First real tests: projects CRUD, a chat turn, promote-chat, area sectioning,
   one E2E happy path. (Proves the harness.)
3. Flesh out: per-module unit coverage + more E2E flows (follow-up agents).
