# @paddock/server

## 0.27.0

### Minor Changes

- [#241](https://github.com/edspencer/paddock/pull/241) [`ecde9bd`](https://github.com/edspencer/paddock/commit/ecde9bd36c1536428d89007594fa1cfc74513855) Thanks [@edspencer](https://github.com/edspencer)! - feat(#239): render image `Read` results inline in the expanded tool block

  Expanding a `Read` of an image (`.png`/`.jpg`/…) previously showed `(no output)` — Claude Code returns an image content block, which herdctl renders as empty text. Building on #237's `Read` enrichment, the server now flags an image read (`readInfo.isImage`) and, when the file resolves **inside the project dir**, exposes a project-relative path (`readInfo.projectRelPath`); the web renders the image inline via the existing raw file endpoint (`/api/projects/:slug/files/:name?raw=1`, the same one the Files tab uses), height-capped and click-to-open at full size.

  History-hydrated only, no herdctl change. An image outside the project dir, or a scratch chat (no servable file endpoint), degrades to the generic block. Path resolution is guarded twice — a `..`/absolute relative path is rejected in the enrichment, and the raw endpoint re-guards traversal against the project dir.

  The inline image treatment is now a shared `InlineImage` component used by BOTH an image `Read` and an agent-sent image (`send_file`): a hover action bar (download / open-in-new-tab / maximize) and a full-screen lightbox, with the image itself click-to-maximize (zoom cursor) so you don't have to hunt for the maximize icon.

- [#238](https://github.com/edspencer/paddock/pull/238) [`702d95f`](https://github.com/edspencer/paddock/commit/702d95f075e8721e5cd07cbe5d2d0be92358ec3e) Thanks [@edspencer](https://github.com/edspencer)! - feat(#237): generalize tool-call enrichment + richer per-tool rendering from the discarded `toolUseResult` sidecar

  herdctl's parsed `ChatToolCall` drops two rich sources present on ~100% of tool
  calls: the tool's full `input` and a structured `toolUseResult` sidecar. We'd
  recovered raw transcript data three times in one-off modules (`subagents.ts` #37,
  `background.ts` #230, `editdiff.ts` #232). This generalizes that into one shared
  server-side pass — `enrichWithToolDetails` — that recovers `{input, toolUseResult}`
  for every paired tool_use (mtime-cached raw-JSONL stream, paired-only + file-ordered,
  positional-join with the defensive `toolName` check) and derives per-tool structured
  fields. `editdiff.ts`'s hand-rolled LCS diff is retired: the diff now comes from
  `toolUseResult.structuredPatch` (real file line numbers). The two history routes call
  the one orchestrator.

  Richer `ToolBlock` treatments, gated on the new fields (degrading to the generic
  block otherwise):

  - **Edit/Write** — real `@@ -old +new @@` hunk headers + an old/new line-number gutter.
  - **Read** — `basename · lines 33–40 of 210` header (full path on hover), fixing the
    long-path cutoff.
  - **Bash** — split stderr (red), `interrupted` badge, exit-code interpretation, and a
    git affordance from `gitOperation`.
  - **Grep/Glob** — match/file count chips.
  - **TaskUpdate** — `pending → in_progress` status pills; **TaskCreate** — the task
    subject + description.

  History-hydrated only (the live WS frame carries none of this); no herdctl change.

## 0.26.0

### Minor Changes

- [#235](https://github.com/edspencer/paddock/pull/235) [`d16080b`](https://github.com/edspencer/paddock/commit/d16080bdd0a9b2a27988ec99e4bce1044688a279) Thanks [@edspencer](https://github.com/edspencer)! - fix(#175): render in-flight tool calls (esp. subagents) with a pending "running…" state

  Long-running tools — especially subagents (`Task`/`Agent`) that run for minutes —
  previously showed nothing in the transcript until they completed, because the
  live stream only surfaced a tool once its `tool_use` was paired with its
  `tool_result`. Consuming `@herdctl/chat@0.6.0`'s new `onToolStart`, the server
  now emits a `chat:tool_start` frame the moment a tool begins (carrying
  `toolUseId` + `parentToolUseId`), and adds `toolUseId` to `chat:tool_call` so the
  completion can be reconciled. The web client appends a pending tool row on
  `chat:tool_start` (spinner + "running…", keyed by `toolUseId`) and replaces it
  in place when the matching `chat:tool_call` arrives — so a slow tool/subagent is
  now visibly in flight instead of invisible until done. Reconnect-safe (dedups
  replayed start frames) and backward compatible (falls back to append when no
  pending row exists).

## 0.25.0

## 0.24.0

### Patch Changes

- [#224](https://github.com/edspencer/paddock/pull/224) [`42e4212`](https://github.com/edspencer/paddock/commit/42e421214e83f78bbc1f1dd86f7b69d1e6e655e0) Thanks [@edspencer](https://github.com/edspencer)! - fix(server): return 404 for missing static assets instead of the SPA shell (#220)

  The SPA not-found handler served `index.html` (HTTP 200, `text/html`) for _any_
  non-`/api`/`/ws` GET, including missing hashed assets. After a deploy, a client or
  service worker still referencing an old chunk hash received HTML for a JS/CSS
  module → "Failed to load module script" ("Unexpected application error: a module
  script failed"), which the service worker then cached under the asset URL. Missing
  static assets (paths with a file extension that aren't real navigations) now 404;
  client-side routes — including dotted file deep-links carrying `Accept: text/html`
  or `Sec-Fetch-Mode: navigate` — still resolve to the shell.

- [#225](https://github.com/edspencer/paddock/pull/225) [`55152e4`](https://github.com/edspencer/paddock/commit/55152e490aca3a6df2dd20808459dd49833b0abf) Thanks [@edspencer](https://github.com/edspencer)! - fix(server/auth): exempt immutable static assets from the JWT gate (#223)

  In `jwt`/`trusted-header` mode the auth `onRequest` hook required a valid token for
  _every_ request, including the content-hashed front-end bundle (`/assets/**`,
  `/icons/**`, `/fonts/**`, `/sw.js`, `/manifest.webmanifest`, `/favicon.ico`). During
  an identity-proxy session-refresh window those asset/module fetches would 401 →
  "Load failed" / "module script failed". Those immutable, non-sensitive static
  assets are now served without the token; the app shell (index.html / client routes)
  and every data route (`/api`, `/ws`) stay authenticated.

## 0.23.0

### Minor Changes

- [#215](https://github.com/edspencer/paddock/pull/215) [`509c445`](https://github.com/edspencer/paddock/commit/509c4450738eb6af74c3cfb7642c2199df59e8b6) Thanks [@edspencer](https://github.com/edspencer)! - Add the read-only Paddock self-management MCP (issue #214, Phase 1). When `PADDOCK_SELF_MCP` is set, keeper turns are handed a `paddock_manage` MCP server exposing three read-only tools — `list_projects`, `list_chats` (cross-project), and `read_chat` (a trimmed, length-capped transcript tail) — so a keeper can inspect Paddock itself. Injected via herdctl's `injectedMcpServers` (same mechanism as `send_file`); keeper-only (never scratch) and off by default. Write tools (create/fork/message) and the external bridge are later phases.

- [#218](https://github.com/edspencer/paddock/pull/218) [`050c3d3`](https://github.com/edspencer/paddock/commit/050c3d3903ec7c2b022b1872cd8fd707a4bd5bb9) Thanks [@edspencer](https://github.com/edspencer)! - Add the Paddock self-management MCP **write tools** (issue #214, Phase 2). Behind the new `PADDOCK_SELF_MCP_WRITE` flag (on top of `PADDOCK_SELF_MCP`), keeper turns additionally get `create_chat`, `fork_chat`, `send_message`, and `fork_chat_batch` (fan-out) on the `paddock_manage` MCP server.

  Each starts a real keeper turn routed through the shared SessionHub, so a spawned chat appears in the sidebar, flips the running indicator, streams live, and is re-attachable — full parity with a human-started turn. `fork_chat_batch` (cap 20) is the fan-out primitive: fork the current chat N times, one kickoff directive per line, run concurrently. Keeper-only; off by default; gated separately from the read tools because these start real work.

  Containment: spawned turns get `send_file` only, not the self-MCP, so an automated fan-out cannot recurse into a fork bomb (a spawned chat regains the tools only when a human later drives it). No explicit recursion guard is built this phase (per #214); the injection path stays guard-ready.

  Fork kickoffs are framed so a forked child treats the inherited (possibly mid-turn) transcript as context and runs its directive instead of inheriting the parent's identity. `fork_chat_batch` takes its list as newline/JSON text (the CLI-runtime MCP transport drops array-typed args). `fork_chat`/`send_message` validate the target session and return a clean "chat not found" instead of a raw ENOENT / false success.

### Patch Changes

- [#217](https://github.com/edspencer/paddock/pull/217) [`6e4b26d`](https://github.com/edspencer/paddock/commit/6e4b26d5124b03cf36c7e52a450e01b390579c91) Thanks [@edspencer](https://github.com/edspencer)! - chore(deps): bump @herdctl/core ^5.20.0 → ^5.20.1

  Picks up the session-reaper fix from [herdctl#368](https://github.com/edspencer/herdctl/issues/368) / [herdctl#369](https://github.com/edspencer/herdctl/pull/369): an asynchronous background task's completion no longer reaps the managed session out from under the SDK's re-invocation turn. This fixes keepers "stopping" the instant a `run_in_background` task (a CI-watch loop, a background Explore/research agent, a long build) finishes — the re-invocation that delivers the task's result now survives, so autonomous cross-turn work in session drive-mode completes instead of silently stalling.

## 0.22.0

### Minor Changes

- [#205](https://github.com/edspencer/paddock/pull/205) [`1c0682c`](https://github.com/edspencer/paddock/commit/1c0682c08d8c63ae5516dd2a71a7f2591c3922c7) Thanks [@edspencer](https://github.com/edspencer)! - Ship the web UI as an installable PWA (#199): add a web app manifest, brand
  icons (192/512 + maskable + apple-touch-icon), browser-tab favicons (16/32 PNG +
  `favicon.ico`; the app previously had none), iOS standalone `<head>` tags, and
  a dependency-free service worker (registered in production only) that caches the
  app shell for offline launch. Navigations are network-first with a cached-shell
  fallback (covering both true-offline and app-server-down cases); `/api` and `/ws`
  are never cached. This enables Add-to-Home-Screen + full-screen standalone launch
  and is the prerequisite for Web Push notifications (#200).

### Patch Changes

- [#210](https://github.com/edspencer/paddock/pull/210) [`fbbc5a4`](https://github.com/edspencer/paddock/commit/fbbc5a4541c54318e5f7ddb50df3247caa9ff510) Thanks [@edspencer](https://github.com/edspencer)! - Repo-backed projects now do a **full clone** (not `--depth 1`). A repo-backed
  project is where you do engineering, so the keeper should have real history —
  `git log`, blame, bisect, and a non-shallow base for branches/PRs — from the
  moment the project is created.

## 0.21.1

### Patch Changes

- [#209](https://github.com/edspencer/paddock/pull/209) [`9425c27`](https://github.com/edspencer/paddock/commit/9425c2754808190e15a75620b715b26eed681ae4) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to 5.20.0. This fixes the session-reaper closing a keeper's
  streaming session out from under it when a **synchronous** subagent finishes —
  the "keeper stops right after a subagent completes" stall seen on session
  drive-mode instances (herdctl #366 / PR #367). Also picks up the harness
  `<task-notification>` transcript-parser fix (herdctl #364).

- [#207](https://github.com/edspencer/paddock/pull/207) [`965656c`](https://github.com/edspencer/paddock/commit/965656c92c3ae90f8386f12bc28b856d3a548183) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to `^5.19.2`. This picks up the CLI session-path fix for herdctl#357: new CLI sessions are now identified by set-difference against a pre-spawn snapshot of `.jsonl` files rather than the old newest-by-mtime heuristic, which is the root cause of keeper chats intermittently getting mis-attributed to the post-turn sweep and vanishing from the sidebar (paddock#154).

## 0.21.0

### Minor Changes

- [#194](https://github.com/edspencer/paddock/pull/194) [`9550a6f`](https://github.com/edspencer/paddock/commit/9550a6f68c57a5ef1ab70a6debf2cbac1ac4b9b2) Thanks [@edspencer](https://github.com/edspencer)! - feat(projects): repo-backed project type (#187)

  Add a second project type: a project **linked to its own external git repo**,
  cloned as the keeper's working directory — the natural unit for doing engineering
  (vs. the notebook project, which is a directory in the instance data repo).

  - **Data model:** a `repo:` URL in `project.yaml` marks a project repo-backed;
    the DTO gains `workingDir`, `repoBacked`, and `repo`. Set at creation, immutable.
  - **Clone-on-create:** Paddock clones the repo into a nested `.gitignore`d checkout
    under the project dir and sets the keeper's cwd to that checkout — so the repo's
    **own** `CLAUDE.md`, git history, branches and PR flow work natively (verified
    end-to-end: a keeper turn's `pwd` is the checkout and it reads the repo's CLAUDE.md).
    A clone failure rolls the half-created project back.
  - **Sweeper split:** `OVERVIEW.md` + `CHANGELOG.md` are still curated for both types,
    sidecarred in the metadata dir (never written into the checkout). The per-project
    `CLAUDE.md` is **notebook-only** — a repo-backed project defers to the repo's own,
    which the sweeper never touches.
  - **Transcripts** stay in the metadata dir even when the cwd is the checkout, so they
    never pollute the external repo's working tree.
  - **Web:** a "Git repository URL (optional)" field in the New Project modal and a
    "Repo" badge (+ Home metadata row) on repo-backed projects. Also fixes the modal
    swallowing create errors (a failed create now shows the message and keeps the form).

  Follow-ups (documented, out of scope): per-repo scoped credentials for private
  repos / push / PR (OpenBao), and DR re-clone on rebuild.

## 0.20.1

### Patch Changes

- [#185](https://github.com/edspencer/paddock/pull/185) [`6a0d0a7`](https://github.com/edspencer/paddock/commit/6a0d0a7ac963567e8d20075830958b24b3e1bec0) Thanks [@edspencer](https://github.com/edspencer)! - Decouple the keeper/scratch replace system-prompt from `PADDOCK_DEV_SERVERS_ENABLED` (#176). Whether an agent uses the native Claude Code system prompt + CLAUDE.md hierarchy vs. a terse Paddock replace prompt is now its own explicit decision, driven by `PADDOCK_KEEPER_NATIVE_PROMPT` (default `true` — native — on every instance) instead of piggy-backing on the unrelated dev-servers capability flag. Scratch chats now also get the native default + instance-wide CLAUDE.md by default. Set `PADDOCK_KEEPER_NATIVE_PROMPT=false` to keep the old replace prompt on an instance with no CLAUDE.md files.

- [#193](https://github.com/edspencer/paddock/pull/193) [`85db081`](https://github.com/edspencer/paddock/commit/85db081c386da47d4c101db6885ca154f675cb81) Thanks [@edspencer](https://github.com/edspencer)! - Preload now injects `CHANGELOG.md` alongside `OVERVIEW.md` (#188). Previously the "Preload project context" checkbox only prepended `OVERVIEW.md` to a new project chat's first turn, so the cross-session narrative in `CHANGELOG.md` — written by the sweeper but never fed to a chat — was effectively write-only. The checkbox now opts into **both**: when a curated overview exists, the first turn's `<project-context>` block carries the overview (current state) _and_ the changelog (history). Gating is unchanged (still requires an `OVERVIEW.md`, i.e. a sweep has run), and the display-strip round-trip is preserved.

- [#192](https://github.com/edspencer/paddock/pull/192) [`3b93dc4`](https://github.com/edspencer/paddock/commit/3b93dc40abceac45a72f3f11c8c2dd186689efc2) Thanks [@edspencer](https://github.com/edspencer)! - Persist chat read/unread state server-side (#189)

  Read-state (per-chat "last seen") moves off browser localStorage into a
  write-through JSON sidecar (`read-state.json`) in the data dir, so it follows a
  user across devices hitting the same instance. Keyed by username WHEN a real
  identity is present (trusted-header / jwt), else a single shared bucket
  (`none` mode / anonymous) — forward-compatible with multi-user without gating
  chat visibility. The chat DTO (list + detail) and `/api/projects` `chatTurns`
  now carry `lastSeen`; new `POST /api/projects/:slug/chats/:sessionId/seen`
  (and scratch `/api/chats/:sessionId/seen`) mark a chat seen, and `GET /api/me`
  exposes the principal. The web `lastSeen` helper becomes a thin cache layering
  the server value (source of truth) over an optimistic localStorage mirror.

- [#186](https://github.com/edspencer/paddock/pull/186) [`f78dc05`](https://github.com/edspencer/paddock/commit/f78dc056dd64f77e434a56e8a305ef37618357b1) Thanks [@edspencer](https://github.com/edspencer)! - Sweeper now maintains a per-project `CLAUDE.md` (durable identity & conventions) alongside `OVERVIEW.md` (current state) and `CHANGELOG.md` (history) (#177). A minimal `CLAUDE.md` is seeded at project creation, and each sweep may emit an optional `<<<CLAUDE>>>` section carrying only genuinely-new durable facts; `SweepService` **appends** them under a managed "Curated notes" heading rather than rewriting, so human-authored conventions are never clobbered. When the sweeper has nothing durable to add it emits `NOCHANGE` and the file is left untouched. Pairs with #176 so the per-project `CLAUDE.md` is auto-loaded as the project layer of the two-level native-context model.

## 0.20.0

### Minor Changes

- [#183](https://github.com/edspencer/paddock/pull/183) [`8576207`](https://github.com/edspencer/paddock/commit/8576207c74abd5d4d1fc012629318fecd7f16d0f) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/chat` `^0.4.8` → `^0.5.5` so `@herdctl/core` resolves to a single hoisted `5.19.1` (was split: a stale `5.15.1` hoisted by chat's exact pin, `5.19.1` nested under the server) and `@anthropic-ai/claude-agent-sdk` resolves to `0.3.x` (was `0.1.77`) (#182). This actually delivers what session drive-mode promises on-box: the herdctl#303 native agentic toolset (`ScheduleWakeup`, `Cron*`, `Monitor`, background tasks) in the `openChatSession` harness, and the herdctl#307 session-lifecycle reaper that keeps a streaming session alive while `background_tasks` is non-empty (so a detached background subagent survives the turn boundary — #180) and re-fires `ScheduleWakeup`/`/loop` via the scheduler.

  Also makes the server integration suite hermetic to the box's `PADDOCK_KEEPER_DRIVE_MODE` env: the test harness now forces the default batch/CLI-runtime path so the fake-`claude` fixture is exercised regardless of a `session` value in the ambient environment (which would otherwise route turns through the SDK runtime and fail with "Not logged in" in a token-less CI/test env).

## 0.19.2

### Patch Changes

- [#167](https://github.com/edspencer/paddock/pull/167) [`07c56b8`](https://github.com/edspencer/paddock/commit/07c56b8f6c91357627b7199c57e953d9a4b53d48) Thanks [@edspencer](https://github.com/edspencer)! - Fix the composer context meter under-reporting context by dropping cache tokens (#165). The live `chat:complete` usage now keeps the usage block with the largest context snapshot instead of the last non-null one, so the terminal cache-less result message no longer clobbers the assistant block's cache reads.

- [#172](https://github.com/edspencer/paddock/pull/172) [`ff84e5d`](https://github.com/edspencer/paddock/commit/ff84e5dece1c34a62924eecae8fc353d5f3227df) Thanks [@edspencer](https://github.com/edspencer)! - Sidebar per-project badges: unread-reply count + in-flight count, replacing the per-row StatusPill (#161)

- [#170](https://github.com/edspencer/paddock/pull/170) [`4ebea5f`](https://github.com/edspencer/paddock/commit/4ebea5ff9a9c82a1e70f3e454d3bf68ce8e18dfa) Thanks [@edspencer](https://github.com/edspencer)! - Show a sub-agent's estimated API-rate cost (USD) next to its duration in the expandable sub-agent block, priced per-model from the sub-agent's own transcript (#166)

- [#171](https://github.com/edspencer/paddock/pull/171) [`13a2ff8`](https://github.com/edspencer/paddock/commit/13a2ff85b3e50031253ca04174da9cd31abfb9e5) Thanks [@edspencer](https://github.com/edspencer)! - Add a subtle "unread" affordance to per-project chat rows: a chat is marked unread when the agent finishes a turn while the user isn't viewing it, and read when opened/focused. Adds a `lastTurnCompletedAt` chat DTO field sourced from herdctl job records (#160).

## 0.19.1

## 0.19.0

### Minor Changes

- [#152](https://github.com/edspencer/paddock/pull/152) [`d54c642`](https://github.com/edspencer/paddock/commit/d54c642777c5e987a5141351bacec471c19d32ac) Thanks [@edspencer](https://github.com/edspencer)! - feat(usage): per-chat cumulative token consumption + cost estimate

  The context ring/meter only ever showed the _last turn's_ context-window fill
  (`input + cache_read + cache_creation`), never how many tokens a whole chat has
  consumed. A new server-side transcript extractor (`usage.ts`) sums every
  assistant turn's input, output, cache-read and cache-creation tokens (deduped by
  message id, like core) and prices them at first-party API list rates — output,
  cache-write (1.25× input) and cache-read (0.1× input) each priced separately, so
  the figure neither double-counts the growing context nor misprices output.

  The `ChatUsage` DTO (bulk `/chats/usage` + per-chat `/context`) now carries the
  cumulative totals and a `costUsd` estimate alongside the existing context-fill
  fields. The chat-list usage ring tooltip and the in-chat status row surface a
  "session so far" summary (e.g. `1.25M tokens · 910K in / 340K out · ~$4.10 at
API rates`); the in-chat figure refreshes after each completed turn. On the
  Max/CLI runtime this cost is informational (no per-token quota) — the token
  counts are the honest metric, and `costUsd` is null for a model with no known
  pricing. No `@herdctl/core` changes.

## 0.18.4

### Patch Changes

- [#153](https://github.com/edspencer/paddock/pull/153) [`c747064`](https://github.com/edspencer/paddock/commit/c747064c144f00006291725a01750e4995ea2efd) Thanks [@edspencer](https://github.com/edspencer)! - chore(deps): bump @herdctl/core to ^5.19.1

  Picks up the 5.19.1 session-discovery perf work: negative-caching of
  resolveAutoName/resolvePreview (warm project-switch enrichment ~580ms → tens of
  ms), an mtime-keyed cache for parseSessionMessages (repeat chat opens skip the
  full re-parse), and dropping the duplicated tool output from the message payload.
  Pairs with the Paddock-side subagent read cache (#147) and transcript
  virtualization (#148).

- [#149](https://github.com/edspencer/paddock/pull/149) [`65e0db5`](https://github.com/edspencer/paddock/commit/65e0db5ce0a624613d310d1bf9961054a6043474) Thanks [@edspencer](https://github.com/edspencer)! - perf(server): mtime-cache the sub-agent transcript reads so refreshing a sub-agent chat skips the 2nd parse

  Opening a chat that used a Task/Agent sub-agent re-streamed the **entire main
  transcript a second time** (`readTaskUsesFromFile`, to recover the tool*use ids
  core's parser drops) and read every sub-agent `.jsonl` in full
  (`readSubagentDurationMs`) — on \_every* open, including a plain refresh of an
  unchanged chat. On the constrained host that doubled the ~114ms parse of a large
  transcript plus the sub-agent file reads, all synchronously on the event loop.

  Both per-file reads are now memoized keyed on the file's mtime (mirroring core's
  message cache from herdctl #351). A transcript is immutable except when a new turn
  appends (which bumps mtime), so a refresh of an unchanged sub-agent chat skips the
  second parse and the sub-agent reads entirely; a new turn invalidates the affected
  entries. Caches are LRU-bounded to cap memory.

## 0.18.3

### Patch Changes

- [#145](https://github.com/edspencer/paddock/pull/145) [`641bbc6`](https://github.com/edspencer/paddock/commit/641bbc632ebad2ac22b792d423b0f8ab05fddd7a) Thanks [@edspencer](https://github.com/edspencer)! - chore(deps): bump @herdctl/core to ^5.19.0

  Picks up the session-discovery performance work in core 5.19.0: derived
  per-session facts (isSidechain, usage) are now persisted in the metadata store
  keyed on mtime, the `getAgentSessions` enrichment loop runs with bounded
  concurrency, and the attribution index rebuilds incrementally. Together these
  cut the per-switch work that made project switching slow — the usage-ring reads
  Paddock issues via `chats/usage` (and the per-chat `/context` endpoint) now hit
  a durable, restart-surviving cache instead of re-streaming every transcript.

## 0.18.2

## 0.18.1

### Patch Changes

- [#138](https://github.com/edspencer/paddock/pull/138) [`4a121b6`](https://github.com/edspencer/paddock/commit/4a121b6dd43863833db5c316af86d45d45b8692d) Thanks [@edspencer](https://github.com/edspencer)! - Give reloaded transcript turns a stable, reload-safe id derived from the source message's uuid (#135).

  Every rendered `Turn` previously got an in-memory render counter (`t${n}`) that was reassigned on each render, so nothing could remember state about a specific message across reloads. Now:

  - **Server:** bump `@herdctl/core` to a version that surfaces `ChatMessage.uuid` (the Claude Code JSONL per-entry uuid; herdctl#312). It flows through the messages endpoint unchanged (the `EnrichedMessage` DTO inherits it and `enrichWithSubagents` preserves it).
  - **Web:** `HistoryMessage` gains an optional `uuid`, and `historyToTurns` keys each turn's id on it. A single JSONL entry can yield sibling messages that share one uuid (text + tool_use, or multiple tool_uses), so the 2nd+ sibling is suffixed `#<n>` to keep React keys unique while staying deterministic. Messages without a uuid (older transcripts) fall back to the render counter.

  This is the foundation for per-message UI state that persists across reloads (e.g. resizable transcript items, #136). No visible behavior change on its own.

## 0.18.0

### Minor Changes

- [#130](https://github.com/edspencer/paddock/pull/130) [`3d50354`](https://github.com/edspencer/paddock/commit/3d503546c87c1bd914751ee97524d802c19091e6) Thanks [@edspencer](https://github.com/edspencer)! - Add a per-project **Settings** tab (`/projects/:slug/settings`) as the canonical place to view and edit every project setting, replacing the cramped `EditProjectModal` (now retired). Settings are grouped and documented — Identity & metadata (name, summary, status, area, visibility, domain tags, labelled links, plus read-only slug/started/created), Keeper agent (model with context-window note, permission mode with a `bypassPermissions` caution, max turns, Docker sandbox, drive mode), and read-only Derived state (overview, pinned files). All "Edit" affordances now deep-link to the tab.

  `driveMode` shows its inherited-vs-overridden state: "Global default" surfaces the box-wide `PADDOCK_KEEPER_DRIVE_MODE` (newly exposed on `GET /api/models` as `keeperDriveModeDefault`), and an override can be reset back to inherit. Clearing now actually works end-to-end — `PATCH /api/projects/:slug` accepts `driveMode: null` to delete the override (a plain omitted/`undefined` field could never clear a persisted value).

## 0.17.1

### Patch Changes

- [#131](https://github.com/edspencer/paddock/pull/131) [`5df7543`](https://github.com/edspencer/paddock/commit/5df7543febc7747861795ec7a6386b646f69fddc) Thanks [@edspencer](https://github.com/edspencer)! - feat: inline PDF viewer for agent-sent files (#128)

  A `.pdf` sent via `mcp__paddock__send_file` (`file_path`) now renders inline in
  a scrollable viewer instead of decoding its bytes as UTF-8 garbage in a `<pre>`.

  - Server infers `kind: "pdf"`, serves the bytes as `application/pdf`, and drops
    the `sandbox` CSP for PDFs (a bare `sandbox` stops the browser's native viewer
    from painting) while keeping `default-src 'none'` so nothing inside the PDF can
    script or phone home. Inline `content` PDFs are rejected (binary needs a file).
  - Web renders a native `<object>` viewer (no pdf.js / new deps) with an
    open-in-new-tab + download fallback for browsers that can't inline a PDF.

- [#132](https://github.com/edspencer/paddock/pull/132) [`27bf1b6`](https://github.com/edspencer/paddock/commit/27bf1b645eb257d9d9fe190b6b8d792e97ad6e56) Thanks [@edspencer](https://github.com/edspencer)! - Add an inline video player for files shared via `mcp__paddock__send_file` (issue #126). An agent can send a screen recording (e.g. a Playwright `recordVideo`) via `file_path` and the user sees a playable `<video>` with controls that survives page reload. The chat-file endpoint (`/api/chat-files/:id`) now supports HTTP byte ranges (`206 Partial Content`), which is what makes mobile Safari / iOS play a `<video>` at all; video is served with a plain `default-src 'none'` CSP (no `sandbox` token) so nothing interferes with playback. `.mp4`/`.webm`/`.mov`/`.m4v` infer the `video` kind (the image check still runs first so `.webp` is never confused with `.webm`), and the attachment size cap is raised to 100 MB. No new dependencies.

## 0.17.0

### Minor Changes

- [#123](https://github.com/edspencer/paddock/pull/123) [`5101dcb`](https://github.com/edspencer/paddock/commit/5101dcbbff1676f538b7fd35b8967b291f40e82b) Thanks [@edspencer](https://github.com/edspencer)! - Keeper cross-turn autonomy via a session drive-mode (#111). Keepers can now schedule a `ScheduleWakeup` / `/loop` and be re-invoked when it fires, instead of the work silently dying at the turn boundary.

  - **`driveMode` per keeper turn** — `batch` (legacy one-shot `trigger()`) or `session` (a persistent, herdctl-managed `openChatSession` with `manageLifecycle: true`, so idle sessions are reaped and their timer-class wakeups re-fired by herdctl's scheduler — herdctl#307). Resolved global → project: `PADDOCK_KEEPER_DRIVE_MODE` env default (defaults to `batch`) overridden by a per-project `driveMode` setting. Consumes `@herdctl/core@5.18.0`.
  - **Woken turns land in the chat** — a scheduler-fired wake runs with no client attached; its output is streamed onto the hub / transcript / attribution exactly like a human turn (client-less turns supported in the session hub).
  - **Stop fix (both modes)** — the Stop button was a no-op whenever the model was still "thinking" (no content frame had yet carried the `jobId`), so the client had nothing to cancel. The hub now re-broadcasts `chat:active` the instant the `jobId` resolves, arming Stop immediately. Session-mode Stop maps to `session.interrupt()`; batch-mode Stop still aborts the job.
  - Keeper `allowed_tools` now include the timer-class autonomy tools (`ScheduleWakeup`, `Monitor`, `Cron*`, `ToolSearch`), which the runtime previously auto-denied.

## 0.16.0

### Minor Changes

- [#118](https://github.com/edspencer/paddock/pull/118) [`d0c129d`](https://github.com/edspencer/paddock/commit/d0c129d209b33b76c2c4185aefef88d4d6ab2504) Thanks [@edspencer](https://github.com/edspencer)! - Refresh the model picker: add Fable 5 and Sonnet 5, retire Sonnet 4.6.

  `packages/server/src/models.ts` (the single source of truth for the picker,
  keeper/sweeper defaults, and context-meter limits) now offers **Opus 4.8**,
  **Fable 5** (`claude-fable-5`), **Sonnet 5** (`claude-sonnet-5`), and **Haiku
  4.5**. The stale **Sonnet 4.6** entry is replaced by Sonnet 5. Fable 5 and
  Sonnet 5 both carry a 1M-token context window (matching Opus 4.8).

  The keeper default (Opus 4.8) and sweeper default (Haiku 4.5) are unchanged.
  Fable 5 was verified to run on the Max/CLI keeper runtime, so no plan/entitlement
  change is required — it's a picker addition only.

### Patch Changes

- [#119](https://github.com/edspencer/paddock/pull/119) [`d9c0f2e`](https://github.com/edspencer/paddock/commit/d9c0f2e23a9c2bf0372a3fd4227a1abdf8d4364d) Thanks [@edspencer](https://github.com/edspencer)! - perf: don't block the project view on per-chat context-usage rings (#116)

  Switching into a project scaled with its chat count (2–3s on chat-heavy
  projects) because `GET /api/projects/:slug` computed a context-usage ring for
  every chat, and each ring streams+parses that chat's entire transcript. The
  whole ProjectView waited on this.

  The chat list and project detail now come back usage-free (from cached
  name/preview/mtime), so the view renders immediately. A new
  `GET /api/projects/:slug/chats/usage` endpoint returns the per-chat usage map,
  which the client fetches separately and merges into the sidebar rings after the
  view has rendered (and again after a turn completes). Behavior is otherwise
  unchanged — the rings still show the same fill.

## 0.15.0

### Minor Changes

- [#113](https://github.com/edspencer/paddock/pull/113) [`9c45800`](https://github.com/edspencer/paddock/commit/9c458007415b40e8ff1b35542891aa45ccfb493c) Thanks [@edspencer](https://github.com/edspencer)! - Add a Paddock-native `send_file` MCP tool (`mcp__paddock__send_file`) so keeper
  and scratch agents can render a file inline in the chat. It accepts either a
  real `file_path` or inline `content` + `filename` for a virtual/illustrative
  file, plus an optional `kind`/`language` hint. The web chat renders it with the
  same Markdown (live Mermaid) / code / image componentry as the Files tab.

  Wired via herdctl's `injectedMcpServers` (in-process handler fronted by the CLI
  runtime's HTTP MCP bridge), so no static allow-list change is needed. The tool
  returns a JSON envelope as its result `output`, which is preserved verbatim both
  live and by herdctl's history parser — so a `send_file` call renders through the
  ordinary tool-call path and looks identical after a page reload.

  Real files are copied into a per-instance attachment store at send time and
  addressed by an opaque id, so a shared file is an immutable snapshot (renders
  forever, even if the original is later edited, moved, or deleted), the agent can
  send from anywhere (no working-directory restriction), and the byte-serving
  endpoint only ever exposes files that were explicitly sent. Attachments are
  cleaned up when their chat is deleted. Inline/virtual content stays in the
  transcript envelope so it remains in the agent's context.

## 0.14.0

### Minor Changes

- [#110](https://github.com/edspencer/paddock/pull/110) [`bb5d62b`](https://github.com/edspencer/paddock/commit/bb5d62b63e5b81e9b41a22cb74355240563c2765) Thanks [@edspencer](https://github.com/edspencer)! - Slash-command autocomplete in the composer (#103).

  Typing `/` as the first character of the composer now pops a keyboard-navigable
  menu of the commands available to the chat's agent — built-ins (`/compact`,
  `/clear`, …) plus the project's `.claude/commands` and any MCP-provided commands.
  The menu filters by the text after the slash (case-insensitive substring on the
  name), shows each command's name / argument hint / description, and supports
  ArrowUp/ArrowDown to move, Enter/Tab to accept, Escape to dismiss, and
  mouse hover/click. Accepting inserts `/name ` and closes the menu; a fully-typed
  command sent with Enter still routes through the existing `sendCommand` path
  unchanged (this is discovery/entry assistance only).

  Server: a cached, read-only `GET /api/projects/:slug/commands` (and a
  `GET /api/commands` scratch equivalent) backed by `@herdctl/core`'s new
  `FleetManager.listAgentCommands` (herdctl#300). The list is stable per project
  and each underlying call spawns a short-lived `claude` streaming subprocess, so
  `HerdctlService.listCommands` memoizes per agent for the process lifetime and
  de-duplicates concurrent first calls into a single subprocess. Bumps
  `@herdctl/core` to `^5.16.0` for the new API and re-exported `SlashCommand` type.

### Patch Changes

- [#109](https://github.com/edspencer/paddock/pull/109) [`59d2b92`](https://github.com/edspencer/paddock/commit/59d2b92ec0cdc972b6626f87aa5b2dd2190125f9) Thanks [@edspencer](https://github.com/edspencer)! - Give the project Changes tab a real route, and show untracked files' content (#107).

  The **Changes** tab was local component state overlaying the URL-driven Home /
  Chat / Files tabs, so it couldn't be deep-linked or bookmarked, didn't survive a
  refresh, and back/forward didn't treat entering/leaving it as navigation. It now
  has its own route — `/projects/:slug/changes[/:file]` — mirroring `files[/:name]`:
  the active tab is derived from the URL like the other three, and a specific
  changed file's diff is deep-linkable via `/changes/:file`. The sticky "last tab"
  persistence learns the `changes` sub-path too.

  Selecting an **untracked** file no longer shows a "No diff for this file" dead
  end. `git diff` emits nothing for an untracked path, so the Changes pane now falls
  back to the file's **content** — reusing the existing `GET /files/:name` endpoint
  and its render-kind hint: images render as an `<img>` from the raw-bytes endpoint,
  everything else renders as text (with a "new file · untracked" header). Tracked
  files with a real diff are unchanged.

- [#105](https://github.com/edspencer/paddock/pull/105) [`bc093f3`](https://github.com/edspencer/paddock/commit/bc093f316eb0f3c4b83ef9d83adaec7e5ee3d777) Thanks [@edspencer](https://github.com/edspencer)! - Give chat-list titles the full row width at rest (#104).

  Each chat row's title button reserved a fixed right padding (`pr-[6.75rem]`) for
  the fork/rename/archive/delete actions at all times, even though those actions
  live in an `absolute`, `opacity-0` overlay that only fades in on hover/focus. So
  at rest a title was squeezed into ~half the available width and truncated early,
  leaving a large empty gap where the (invisible) icons would appear.

  The reserved padding is now conditional: a small default (`pr-2.5`) at rest,
  bumped to `pr-[6.75rem]` under `group-hover/chat` / `group-focus-within/chat` so
  the title contracts to make room only when the icons actually become visible.
  Archived rows keep a persistent archive icon, so they retain just enough room
  for that one icon (`pr-[3.75rem]`) at rest.

## 0.13.1

### Patch Changes

- [#101](https://github.com/edspencer/paddock/pull/101) [`d572cc8`](https://github.com/edspencer/paddock/commit/d572cc8f409ffb3f5ee03cca0ef42e733a7af203) Thanks [@edspencer](https://github.com/edspencer)! - Show a new chat in the sidebar while its first turn is still running (#100).

  A brand-new chat used to be invisible in the project sidebar until its first
  keeper turn's `claude -p` process exited — herdctl writes a run's resolved
  `session_id` into its job record only on completion, so mid-turn the session was
  unattributed and filtered out of the session list. Long first turns were
  unreachable from the UI for their whole duration, and navigating away lost the
  chat entirely.

  The server now attributes a new chat to its agent the moment its session id
  first streams back (reusing the same synthetic job-record mechanism as
  fork/promote), so `listSessions` includes it immediately. The web sidebar also
  pulls the chat list when a session starts running that it hasn't listed yet, so
  an in-flight chat surfaces live — even one started from another client/tab.

## 0.13.0

### Minor Changes

- [#99](https://github.com/edspencer/paddock/pull/99) [`b6382de`](https://github.com/edspencer/paddock/commit/b6382de2bcda9c341cfa88ab086c1416b0dbd8f4) Thanks [@edspencer](https://github.com/edspencer)! - feat: archive chats — non-destructive Archive/Unarchive + collapsible Archived section (#95)

  Finished chats can now be filed away instead of only deleted. An Archive button
  sits in each chat's hover menu (beside Fork/Rename/Delete) and toggles to
  Unarchive on an already-archived chat. Archived chats move into a collapsible
  **Archived** section pinned to the bottom of the chat list, collapsed by default
  with a count badge; expanding it splits the list ~50/50 with each half scrolling
  independently. When the currently open chat is archived, the section auto-expands
  on load so you can see where you are. Archiving is a non-destructive toggle — the
  transcript is untouched and the chat stays fully openable, resumable, and
  forkable.

  Server:

  - New `ArchiveStore` sidecar (JSON in the data dir, keyed by agent+session) —
    the same pattern as the sweep watermark; ready to move to @herdctl/core's
    `SessionMetadataStore` when that field ships upstream.
  - Chat DTOs carry an `archived` flag; `POST /api/projects/:slug/chats/:id/archive`
    and `POST /api/chats/:id/archive` toggle it. Deleting a chat clears its flag.

  Web:

  - `archived` on the Chat type; `api.archiveProjectChat` / `api.archiveScratchChat`.
  - ProjectView partitions the list into current + Archived, with the accordion,
    count badge, 50/50 independent-scroll splitter, and deep-link auto-expand.

## 0.12.0

## 0.11.0

### Minor Changes

- [#89](https://github.com/edspencer/paddock/pull/89) [`2679f11`](https://github.com/edspencer/paddock/commit/2679f114e7a165bd863f72a103342516b3df8ce4) Thanks [@edspencer](https://github.com/edspencer)! - feat: fork a chat into an independent child (#77-follow-on)

  A **Fork** button on each chat (in the project sidebar, beside Rename/Delete)
  duplicates it into a new, independent chat in the same project. The fork is
  created **eagerly**: clicking Fork immediately opens a real new chat at
  `/chat/<new-id>` with the parent's **full conversation already populated** and
  titled **"Fork of <parent>"** — so you can branch a conversation into several
  parallel explorations when its context window fills up. The source is left
  untouched, and continuing the fork resumes normally.

  Server: `POST /api/projects/:slug/chats/:sessionId/fork` copies the session's
  transcript into a brand-new session id (rewriting the embedded session id per
  line, `cwd` unchanged), names it, writes an attribution job, and invalidates
  discovery so it appears immediately — mirroring `promoteScratchSession`, minus
  the move/delete. The keeper's `max_concurrent` is lifted from 1 so a project's
  chats (and forks) can run in parallel.

  Web: the Fork button calls the endpoint, records the parent lineage
  (`lib/forkLineage`), refreshes the chat list, and navigates to the new chat
  (auto-focusing the composer). The composer footer shows a **"Fork of <parent>"
  back-link** to the source chat.

  Validated end-to-end against real Claude Code: the copied transcript is a
  discoverable, resumable session that continues with the inherited context, and
  the source is untouched.

### Patch Changes

- [#90](https://github.com/edspencer/paddock/pull/90) [`d37fece`](https://github.com/edspencer/paddock/commit/d37fecee1a49af84a5ab30501420211735e20fd6) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/chat` (0.4.6 → 0.4.8) and `@herdctl/core` (5.14.1 → 5.15.1) to
  pick up the synthetic-message fix (herdctl #293 / #294). After a `/compact`, the
  Claude Code CLI emits a synthetic `"<synthetic>"` placeholder assistant turn
  ("No response requested.") at the head of the next turn; herdctl now filters
  those in both the live SDK-message translator and the transcript parser, so the
  placeholder no longer streams into the chat before the real reply — nor renders
  as a bubble when the chat is reopened.

## 0.10.0

## 0.9.0

## 0.8.0

### Minor Changes

- [#84](https://github.com/edspencer/paddock/pull/84) [`c1ecf0e`](https://github.com/edspencer/paddock/commit/c1ecf0ee47def5bbd87e9e39bfa081db118c84c6) Thanks [@edspencer](https://github.com/edspencer)! - feat: per-chat context-window ring in the chat list (#77)

  Each chat in a project's chat list (and the scratch/one-off list + landing
  preview) now shows a tiny circular gauge filled to that chat's context-window
  usage, mirroring the in-chat `ContextMeter` (same `tokens / limit` percentage,
  amber at ≥80%). The ring hides for chats with no usage data yet.

  Server-side, the chat-list DTOs (`GET /api/projects/:slug`,
  `/api/projects/:slug/chats`, `/api/chats`) now include `contextTokens` /
  `contextLimit`, derived from the same `sessionUsage` + `getContextLimit` the
  `/context` endpoint uses. Per-session usage reads are memoized on transcript
  mtime (`HerdctlService.sessionUsageCached`) so an unchanged transcript isn't
  re-scanned on every list build.

- [#83](https://github.com/edspencer/paddock/pull/83) [`d382c5a`](https://github.com/edspencer/paddock/commit/d382c5a86825722cde9a751b8ba7c96b5ab2ab52) Thanks [@edspencer](https://github.com/edspencer)! - feat: persist unsent composer drafts per chat (#76)

  Typing a message in a chat's composer and switching to another chat — or
  refreshing the page — no longer loses the draft. Unsent composer text is now
  persisted per chat in `localStorage` (keyed by session id, or `new:<slug>` for a
  not-yet-established chat), restored when the chat is reopened, and forgotten once
  the message is sent. Mirrors the existing per-chat model-selection persistence
  (`lib/chatModel.ts`); storage access is guarded so private-mode / quota errors
  never surface.

## 0.7.0

### Minor Changes

- [#80](https://github.com/edspencer/paddock/pull/80) [`28ed532`](https://github.com/edspencer/paddock/commit/28ed5322b779e2ae74faa09c69deb9a968b3c3db) Thanks [@edspencer](https://github.com/edspencer)! - feat: configurable per-instance branding — title, logo, accent color (#34)

  Running several Paddock instances side by side (Projects, Homelab, House, …)
  now lets each be told apart at a glance. Three new env vars, all optional with
  defaults that preserve today's look (🐎 / "Paddock" / terracotta):

  - `PADDOCK_BRAND_NAME` — the wordmark + browser tab title.
  - `PADDOCK_BRAND_LOGO` — the logo glyph/emoji, or a URL/absolute path to an
    image (rendered as an `<img>`).
  - `PADDOCK_BRAND_ACCENT` — the accent color (hex) driving the primary buttons
    (New Project / New Chat) and the logo chip.

  Branding is **runtime** config (one image serves every instance): the server
  injects it into `index.html` at serve time — a `window.__PADDOCK_CONFIG__`
  global plus a `:root` accent override — so there's no title/color flash before
  first paint. The accent moved from build-time Tailwind constants to CSS custom
  properties (`--accent*`, kept as RGB channels so opacity modifiers like
  `bg-accent/15` still work); the 600/700 hover shades are derived from the base.

- [#81](https://github.com/edspencer/paddock/pull/81) [`02b6ac2`](https://github.com/edspencer/paddock/commit/02b6ac23c5a9120840dea96dd4b05de5ec8498fe) Thanks [@edspencer](https://github.com/edspencer)! - feat: per-project keeper-agent settings UI (#12)

  The Edit Project modal now surfaces a project's keeper-agent config, editable in
  the UI: **model**, **permission mode**, **max turns**, and **Docker sandbox**
  on/off. Previously only `model` was persisted per project (and not exposed in
  the UI); `permission_mode`, `max_turns`, and `docker` existed only as fleet-wide
  defaults.

  Each setting is optional on disk and inherits the fleet default when unset (the
  DTO resolves the concrete value). Saving validates the values server-side (400
  on a bad model / permission mode / out-of-range max_turns / non-boolean docker)
  and re-registers the project's keeper agent so the change takes effect. The
  default values are now shared constants, so the fleet `defaults` block and the
  per-project resolution stay in sync.

### Patch Changes

- [#78](https://github.com/edspencer/paddock/pull/78) [`024e1a9`](https://github.com/edspencer/paddock/commit/024e1a90ec1a83f71f1fdf271f59cfe045bb07a5) Thanks [@edspencer](https://github.com/edspencer)! - fix(sweep): keep box/environment dev conventions out of curated OVERVIEW.md (#42)

  The post-turn curation sweep could bake box-level operational conventions (how
  to run/expose a dev server, ports, localhost-vs-dev-hostname, where to clone)
  into a project's `OVERVIEW.md`. Because `OVERVIEW.md` is prepended to every new
  chat, a stray "run on localhost:4100" line there silently overrode the box
  `CLAUDE.md` — a self-reinforcing wrong-setup loop. Both curation prompts now
  tell the curator that `OVERVIEW.md` describes the project (not the box) and must
  not record those conventions, and a deterministic `stripBoxConventions`
  normalizer drops any dev-server/how-to-run sections that slip through before the
  file is written.

## 0.6.0

### Minor Changes

- [#74](https://github.com/edspencer/paddock/pull/74) [`bc189ab`](https://github.com/edspencer/paddock/commit/bc189ab3396b597f0e9c41046d04740087c574d0) Thanks [@edspencer](https://github.com/edspencer)! - Render sub-agent (Task/Agent tool) activity in the chat UI (#37)

  Sub-agent launches now render as a labelled, expandable block showing the
  sub-agent type and description. Expanding lazy-loads the sub-agent's own
  step-by-step transcript inline, recursively (a sub-agent that spawns its own
  sub-agents is expandable to any depth). Implemented entirely paddock-side by
  reading the on-disk `subagents/*.meta.json` sidecars and reusing
  `@herdctl/core`'s `parseSessionMessages`; no upstream change. Handles both the
  `Task` (Claude Code) and `Agent` (Agent SDK) tool names.

### Patch Changes

- [#75](https://github.com/edspencer/paddock/pull/75) [`902cd26`](https://github.com/edspencer/paddock/commit/902cd26c67a35e0fb4f46c8ffbde075669299e1c) Thanks [@edspencer](https://github.com/edspencer)! - Make the chat **Stop** button actually interrupt a running turn. The stop path
  calls `cancelJob`, which previously only rewrote the job's status file while the
  agent kept running — so nothing stopped and the composer stayed locked. Bumping
  `@herdctl/core` to the release that fixes `cancelJob` (it now aborts the live
  run) means a cancel genuinely kills the turn; `trigger()` then returns and the
  server emits the terminal `chat:complete`, so the UI unlocks.

## 0.5.0

### Minor Changes

- [#69](https://github.com/edspencer/paddock/pull/69) [`394715f`](https://github.com/edspencer/paddock/commit/394715f093ced935a5f93956cfe70953c8f6cc61) Thanks [@edspencer](https://github.com/edspencer)! - Add voice dictation to the chat composer (#voice). A microphone button next to
  Send lets you record a spoken message that is transcribed with Whisper and
  dropped into the text area. Works on desktop and mobile.

  Two backends, selected per-instance via `PADDOCK_WHISPER_*` env (mirroring
  HushPod's whisper config so both can share one server):

  - **remote** — POST audio to an OpenAI-compatible `/audio/transcriptions`
    endpoint (`PADDOCK_WHISPER_ENDPOINT`, e.g. a GPU box running
    whisper-server / faster-whisper-server / speaches).
  - **local** — run whisper.cpp on the box via the optional `nodejs-whisper`
    dependency (needs `ffmpeg`).

  Dictation is **off by default** — a plain instance shows no mic button. When
  enabled but the browser can't capture audio (e.g. served over plain HTTP, which
  blocks `getUserMedia`), the button is shown disabled with an explanatory tooltip
  rather than failing silently.

## 0.4.2

## 0.4.1

### Patch Changes

- [#64](https://github.com/edspencer/paddock/pull/64) [`887c290`](https://github.com/edspencer/paddock/commit/887c29043f32012bfa3cb07dbf9502bc7440465e) Thanks [@edspencer](https://github.com/edspencer)! - Chat names no longer show the injected OVERVIEW blob (#62). For a project chat
  with context preload, the first user message is the `<project-context>…` wrapper,
  so the sidebar name fell back to unreadable overview text instead of the user's
  request. (Claude Code's own 100-char preview truncates _inside_ the wrapper, so a
  naive preview-string strip can't recover it.)

  The chat list now, only when there's no better name (no user rename, no
  Claude-generated summary) and the preview is the preload wrapper, reads the
  untruncated first user message and strips Paddock's wrapper to show the real
  request. The wrapper is single-sourced in `preload.ts` (built by the WS layer,
  stripped by the chat list) so the two can't drift. Claude Code's `autoName` is
  still preferred once available; scratch chats (never preloaded) are untouched.

- [#63](https://github.com/edspencer/paddock/pull/63) [`e80c044`](https://github.com/edspencer/paddock/commit/e80c044c03ec1dc4b3f88626a18fe52fb59212bf) Thanks [@edspencer](https://github.com/edspencer)! - Render image files in the Files & Changelog tab instead of mangled binary text
  (#61). Images had no render kind and the file path read every file as UTF-8, so
  a `.png`/`.jpg`/etc. showed replacement-character mojibake.

  Adds an `image` `FileKind` (png, jpg/jpeg, gif, webp, avif, bmp, ico, svg), a
  raw-bytes endpoint (`GET /api/projects/:slug/files/:name?raw=1`) that streams the
  file with the correct `Content-Type` (keeping the path-traversal guard), and an
  `<img>` branch in the file viewer that loads from it. Image bytes are no longer
  UTF-8-decoded. Byte responses carry a locked-down CSP (`sandbox; default-src
'none'`) + `nosniff` so a directly-opened SVG/HTML file can't execute script in
  the app's origin.

## 0.4.0

### Minor Changes

- [#59](https://github.com/edspencer/paddock/pull/59) [`ef44f8b`](https://github.com/edspencer/paddock/commit/ef44f8b0da36d080e0f326b70fe4c7a11dd7a9e3) Thanks [@edspencer](https://github.com/edspencer)! - Surface which chats are streaming, and restore the Stop button when you return to
  a live chat (#52, #53).

  The server now exposes a session's live-turn status via a `chat:active` signal —
  broadcast on every turn start/stop, sent as a snapshot to a newly-connected
  socket, and sent in reply to a `chat:subscribe` for a running session. It carries
  the running flag + the cancellable `jobId`.

  - **#52 — Stop button restored on return.** Switching away from a still-streaming
    chat and back remounts the pane, which previously lost all in-flight state, so
    the composer showed Send (no Stop) and the running turn became uninterruptible.
    A remounting pane now learns its turn is live (with the job id) the instant it
    re-subscribes, so the Stop button — already correctly wired — comes back.
  - **#53 — streaming indicators.** A persistent "agent is working…" pill (with
    cycling status text) shows under the transcript whenever a turn is in flight,
    including the initial thinking gap and the gaps between tool calls, and it lights
    up immediately on return to a streaming chat. The project sidebar shows a small
    pulsing dot next to any chat that is currently streaming — driven in real time
    from the `chat:active` broadcasts, so it works even for chats whose pane isn't
    mounted.

- [#58](https://github.com/edspencer/paddock/pull/58) [`28f06ea`](https://github.com/edspencer/paddock/commit/28f06ea618ed58178327a78792735f9337af8ce5) Thanks [@edspencer](https://github.com/edspencer)! - Chat streams now survive a mid-turn socket drop (#54). A turn's frames were bound
  to the single socket that started it and silently dropped whenever it wasn't
  `OPEN`, so an idle/half-open drop (sleep, wifi change, tab suspend, the client's
  own reconnect) stalled the live stream until a manual reload.

  The server now tracks each session's in-flight turn in a `SessionHub` with a
  bounded, seq-numbered frame buffer and fans frames out to whichever socket(s) are
  attached — not just the origin. A new `chat:subscribe` message lets a
  reconnecting client re-attach to a running turn and replay exactly the frames it
  missed (by `seq`), so the stream resumes seamlessly with no gap and no
  duplication. A just-completed turn's buffer lingers briefly so an end-of-turn
  reconnect still receives the terminal frame; if the missed gap has aged out of
  the buffer the server sends `chat:resync` and the client re-hydrates from the
  transcript.

## 0.3.1

### Patch Changes

- [#51](https://github.com/edspencer/paddock/pull/51) [`bbf6ccf`](https://github.com/edspencer/paddock/commit/bbf6ccffb3996b06381145c92517e55deb59519e) Thanks [@edspencer](https://github.com/edspencer)! - Recover the chat WebSocket after an idle/half-open drop. The client now runs a pong-deadline heartbeat that force-closes a silently-dead socket (triggering reconnect), revives the connection immediately on tab focus / `visibilitychange` / `online`, and queues a send made on a stale socket so it flushes once the connection is confirmed live — instead of writing it into the void. The server adds a protocol-level ping/pong keepalive that reaps dead clients and keeps proxies from evicting idle connections. Fixes #46.

## 0.3.0

### Minor Changes

- [#55](https://github.com/edspencer/paddock/pull/55) [`15cb5ec`](https://github.com/edspencer/paddock/commit/15cb5ec4c8d92805795d6c3f898fbf0a5ebd5d02) Thanks [@edspencer](https://github.com/edspencer)! - Support running slash commands (e.g. `/compact`) in chat.

  Typing a leading-slash message in the composer now routes to a new `chat:command`
  WebSocket path instead of being sent as a plain prompt. The server drives
  herdctl's streaming chat session (`openChatSession`) so the Claude Code CLI
  dispatches the command against the current session — `/compact` compacts the
  real chat history. A compaction is surfaced as a visible assistant note
  ("🗜️ Context compacted (was N tokens)."), and the session list refreshes
  afterwards. Output otherwise streams over the same response/tool/complete events
  as a normal turn.

  Requires `@herdctl/core` >= 5.14.0 (the `FleetManager.openChatSession` streaming
  session API). The session runs on the SDK runtime even though Paddock's keeper /
  scratch agents use the `cli` runtime for batch turns — same subscription auth,
  shared on-disk session store, so a CLI-created chat resumes cleanly.

## 0.2.1

### Patch Changes

- [#49](https://github.com/edspencer/paddock/pull/49) [`f81eaba`](https://github.com/edspencer/paddock/commit/f81eaba137469d4908fab66801698b1b31d94834) Thanks [@edspencer](https://github.com/edspencer)! - Select the chromium engine for the browser MCP (`--browser chromium`)

  `@playwright/mcp` defaults to the `chrome` channel (branded Google Chrome), which isn't installed on the Paddock boxes — so the browser MCP stalled at first use asking to `playwright install chrome`. Pass `--browser chromium` so it uses the open-source Chromium the `paddock` role installs. Verified end-to-end: a keeper-style `claude` session now drives the headless browser and reads live page content.

## 0.2.0

### Minor Changes

- [#48](https://github.com/edspencer/paddock/pull/48) [`876e33c`](https://github.com/edspencer/paddock/commit/876e33c087f6c362a0dd2c827c2e4f330a81dd72) Thanks [@edspencer](https://github.com/edspencer)! - Add an optional Playwright browser MCP to the keeper + scratch agents

  Keeper and scratch Claude Code agents can now drive a headless Chromium via the `@playwright/mcp` server (navigate / click / fill / snapshot / screenshot). The server is attached only when `PADDOCK_BROWSER_MCP=1` is set in the instance env — so a box without the browser stack simply omits it (no failed spawns) and enabling it is a per-box env flip. The `mcp__playwright__*` tool pattern is added to the default agent allowlist unconditionally (a no-op when the server is absent); the tool-less sweeper never receives the server. Chromium runs headless with `--no-sandbox` (`--isolated` profile) for unprivileged-LXC deployments.

### Patch Changes

- [#45](https://github.com/edspencer/paddock/pull/45) [`6cb85de`](https://github.com/edspencer/paddock/commit/6cb85de30aef18e31dca4a8c5636dd8d608ee6b9) Thanks [@edspencer](https://github.com/edspencer)! - Chat history no longer renders injected Claude Code context — a skill's `SKILL.md`, slash-command output — as a giant, out-of-order user message. Picked up via `@herdctl/core@5.13.2`, whose session parser now skips `isMeta` user lines at the source. Fixes #31.

## 0.1.0

### Minor Changes

- [#43](https://github.com/edspencer/paddock/pull/43) [`c72edad`](https://github.com/edspencer/paddock/commit/c72edadce629f15f31bb72d0c4c4c9f46220cb6b) Thanks [@edspencer](https://github.com/edspencer)! - Establish an app-mode release pipeline: changesets-driven versioning + changelog, a multi-arch Docker image published to `ghcr.io/edspencer/paddock`, and a self-contained release tarball attached to each GitHub Release. Packages are not published to npm.
