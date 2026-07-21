# @paddock/web

## 0.39.1

## 0.39.0

### Minor Changes

- [#357](https://github.com/edspencer/paddock/pull/357) [`9ce95af`](https://github.com/edspencer/paddock/commit/9ce95af7a0a0e2174a85ceb41732facd27bcd7f6) Thanks [@edspencer](https://github.com/edspencer)! - Restore "Run now" + live run-status to the Triggers tab (#327). When Epic T folded the Settings→Schedules section into the unified Triggers tab, two capabilities were lost because `TriggerDto` carries trigger config only, not herdctl runtime state.

  - **Run now** — `POST /api/projects/:slug/triggers/:name/run` fires any trigger on demand through the existing `fireTrigger` hub path (a first-class, badged run, regardless of the `enabled` flag), surfaced as a per-row action in the Triggers tab and as a `run_trigger` self-MCP verb.
  - **Live status columns** — `GET /api/projects/:slug/triggers/runtime` joins herdctl job records (last-run, per the #268 run-history pattern) with the cron scheduler's `ScheduleInfo` (next-fire + status) into a per-trigger runtime DTO. The tab polls it to show each trigger's last-run / next-run / running-state.

### Patch Changes

- [#358](https://github.com/edspencer/paddock/pull/358) [`7eef0ed`](https://github.com/edspencer/paddock/commit/7eef0eda4a275fc835ed5b7d1173560dbda4bb08) Thanks [@edspencer](https://github.com/edspencer)! - Render client-local slash commands (`/context`, `/usage`, …) correctly (#158). These commands render their output to a `type:"system"` / `local_command` transcript entry (live: a `model:"<synthetic>"` assistant placeholder) that @herdctl/core's parser and @herdctl/chat's translator both drop — so the command turn used to show nothing useful, leaving only the raw `<command-name>` / `<local-command-*>` scaffolding as empty/user bubbles. Paddock now surfaces the recovered output as a clean, labeled "command output" block in BOTH the live path (ws.ts, mirroring the existing `compact_boundary` note) and on history reload (a new `localcommand.ts` recovery pass re-injects the dropped `<local-command-stdout>`), and the web drops the `<local-command-caveat>` framing note instead of rendering it. `/context` renders its full usage table; `/usage` shows session cost (its plan/rate-limit portion needs an OAuth token with `user:profile` scope, which the keeper token lacks). Paddock's own context ring + cost meter remain the primary usage view.

- [#360](https://github.com/edspencer/paddock/pull/360) [`865f3be`](https://github.com/edspencer/paddock/commit/865f3be55a61f07f2e179b2678d07722289c9fc5) Thanks [@edspencer](https://github.com/edspencer)! - Retire the legacy hook/schedule REST + web-client dead code left behind additively
  during the Epic T triggers migration. The Triggers tab, `/api/projects/:slug/triggers`
  REST, and the `set/list/remove_trigger` MCP tools are now the only surfaces for standing
  agent rules.

  Removed: the pre-T3 `/hooks` and `/schedules` REST routes, `HookService`, the legacy
  hook/schedule runtime dispatch + arming paths, the unused web api-client methods
  (`listHooks`/`putHook`/`listSchedules`/…) and their DTO types, and the
  `HookCapabilityBanner` (superseded by `TriggerCapabilityBanner`). The `project.yaml`
  `hooks:`/`schedules:` block parser is kept for back-compat, alongside the shared
  foundation the trigger system reuses (the reused hooks-MCP gate, the `hook` chat origin,
  and the `.paddock/hooks/sweep.md` sweeper extension).

- [#361](https://github.com/edspencer/paddock/pull/361) [`9a471c7`](https://github.com/edspencer/paddock/commit/9a471c7bf7999e4b50566462a4860153c1b8dde0) Thanks [@edspencer](https://github.com/edspencer)! - Surface turn errors & subscription/usage-limit hits in the UI (#329). When a
  keeper turn was short-circuited by a synthetic runtime message (most commonly
  the shared Claude Max-plan session/usage limit) or failed (network, API
  5xx/overload, auth, crash, or hitting the max-turns cap), the chat used to just
  stop with nothing shown. The turn now classifies these dead-ends and renders a
  distinct inline notice — the reset time for a usage limit, and a Retry/Continue
  affordance where it's safe to re-drive. Both the live streaming path and the
  history-hydration path surface them (the usage-limit case is recovered from the
  raw transcript on reload, since the parser otherwise drops synthetic messages).

## 0.38.3

## 0.38.2

### Patch Changes

- [#348](https://github.com/edspencer/paddock/pull/348) [`bc3366e`](https://github.com/edspencer/paddock/commit/bc3366e2ede8fd0ae15741b1fdf6519a73adda04) Thanks [@edspencer](https://github.com/edspencer)! - Persist unsent composer attachments across navigation and reload (#346).

  The composer already restores unsent **draft text** after a chat switch or page
  reload, but staged **attachments** were dropped — attach a file without sending,
  navigate away or refresh, and the tray came back empty. Attachments are uploaded
  to the server on attach and the composer holds only lightweight refs (the bytes
  live durably in the attachment store), so the fix mirrors the existing draft/queued
  persistence: a new `lib/attachmentRefs.ts` helper stashes the ref array in
  `localStorage` (keyed per-chat by `sessionId` or `new:<slug>`), `ChatPane` seeds
  the tray from it on mount and persists on every tray change, and sending clears it.
  Restored refs whose server file was cleaned up degrade gracefully — a broken image
  falls back to a file chip instead of breaking the composer.

## 0.38.1

## 0.38.0

### Minor Changes

- [#330](https://github.com/edspencer/paddock/pull/330) [`4715a4b`](https://github.com/edspencer/paddock/commit/4715a4ba2a2f4c6084d8950780e399eaa68fbf0b) Thanks [@edspencer](https://github.com/edspencer)! - Add inbound file/image upload in the chat composer (#328 Phase 1, Approach A).

  Pick (single/multi), drag-drop, or paste files into the composer to send them to
  the keeper. Every file is copied into the attachment store and the keeper is
  pointed at the paths, so Claude Code's `Read` tool does native vision on images
  and renders PDFs — no herdctl change (works on the CLI runtime).

  - New `attachments` config group (env `PADDOCK_ATTACHMENTS_*` < YAML <
    per-project `project.yaml`): `enabled` (default true), `maxFileSizeMb` (25),
    `maxFilesPerMessage` (10), `allowedTypes` (default allow-all). Extension +
    MIME-pattern matching with an empty-MIME extension fallback.
  - New `POST /api/projects/:slug/chats/:id/upload` (multipart) with
    server-authoritative enabled/size/count/type validation, reusing the
    `send_file` copy-on-send attachment store (immutable snapshot, cleanup on chat
    delete).
  - Composer picker + drag-drop zone + paste handler + a removable attachment tray
    (image thumbnails / file chips); sent files render in the transcript and
    re-render on reload from the store.

## 0.37.0

### Minor Changes

- [#318](https://github.com/edspencer/paddock/pull/318) [`9d0268e`](https://github.com/edspencer/paddock/commit/9d0268ecba36f5106231b29bd30b6bc348e33088) Thanks [@edspencer](https://github.com/edspencer)! - Per-trigger tool allow-list for **schedule** triggers (Epic T / T2, #307). A
  schedule-type trigger that declares a non-empty `run.tools` allow-list now runs on
  its OWN scoped `trigger-<slug>-<name>` agent — herdctl's `allowed_tools` /
  `permission_mode` / `max_turns` enforce the capability by construction, exactly as an
  event trigger already does. A schedule with no `tools` keeps running as the keeper with
  the project-agent default toolset (pre-T2 behaviour, unchanged). The keeper's forwarded
  `schedules` block remains the cron **timing** only; execution moves to the scoped agent.
  `run.maxSpawnDepth` on a schedule now gates its fired turn's self-MCP spawn capability
  (reuses B1). One shared `triggerRunsOnOwnAgent` predicate makes the arming and fire
  paths agree on the keeper-vs-own-agent routing decision.

- [#325](https://github.com/edspencer/paddock/pull/325) [`30b5f7d`](https://github.com/edspencer/paddock/commit/30b5f7d35a5a84073c88e5e8811ede840c99397c) Thanks [@edspencer](https://github.com/edspencer)! - T4 (Epic T "Unify Triggers"): the per-project **Hooks tab** is renamed and generalized
  into a **Triggers tab**, and the **Settings → Schedules** section is folded into it. One
  list now manages every trigger type — each row shows a `trigger.type` badge (schedule /
  event / webhook), its firing condition, a capability summary, and an enabled toggle — all
  over the unified `/api/projects/:slug/triggers` REST surface (T3). Creating/editing a
  trigger uses a discriminated form (schedule → cron/interval, event → the served `on`
  picker, webhook → shown but reserved). The in-chat capability banner is generalized to
  trigger chats, stating the trigger type, its firing condition, granted tools, permission
  mode, model, and max-turn limits (a new `trigger-<slug>-<name>` chat descriptor served on
  the chat DTO). The legacy `/hooks` route redirects to `/triggers`.

### Patch Changes

- [#324](https://github.com/edspencer/paddock/pull/324) [`7c614f8`](https://github.com/edspencer/paddock/commit/7c614f883027d03eab8054614445f4c6f73bd47d) Thanks [@edspencer](https://github.com/edspencer)! - Fix the project **Settings** page crashing for any project whose `project.yaml`
  declares `links` as a bare YAML string list (the natural shorthand,
  `- https://example.com`) rather than the `{label, url}` object form. Such entries
  reached the DTO as raw strings, and the Settings pane's `cleanedLinks` memo called
  `l.url.trim()` on them, throwing a `TypeError` during render (which also prevented
  the Schedules section from ever loading). `ProjectStore.normalize` now coerces
  `links` at the read boundary via a new `normalizeLinks` helper — a bare string
  becomes `{label: "", url: <string>}`, object links are trimmed and kept, and
  url-less / malformed entries are dropped. Because normalization runs on read, the
  next save round-trips the file into object form, so an affected project self-heals.

## 0.36.0

### Minor Changes

- [#321](https://github.com/edspencer/paddock/pull/321) [`8e3f5a8`](https://github.com/edspencer/paddock/commit/8e3f5a8a6abf11eeea6d021d6a8cc055e4d0a7ee) Thanks [@edspencer](https://github.com/edspencer)! - Switch the built-in default keeper drive mode from `batch` to `session` (#316).

  A fresh/un-configured instance now drives keeper turns through the persistent
  `openChatSession` (SDK runtime) by default, so cross-turn autonomy
  (`ScheduleWakeup`, `/loop`, reaper-backed background work) and SDK streaming work
  out of the box — instead of only when an operator sets
  `PADDOCK_KEEPER_DRIVE_MODE=session`. The env var and per-project `driveMode`
  override still take precedence; set `PADDOCK_KEEPER_DRIVE_MODE=batch` for the
  legacy one-shot `trigger()` path.

  Test hermeticity: the integration harness (fake `claude` on PATH, CLI-runtime
  only) now explicitly pins `PADDOCK_KEEPER_DRIVE_MODE=batch` rather than relying on
  the built-in default, so flipping the default doesn't route token-less test turns
  through the SDK runtime ("Not logged in"). Config docs updated.

- [#320](https://github.com/edspencer/paddock/pull/320) [`930a8aa`](https://github.com/edspencer/paddock/commit/930a8aa6d61d83b425c6ac31403ceca211b4bf5c) Thanks [@edspencer](https://github.com/edspencer)! - Stream keeper replies token-by-token in the web UI (#315).

  Session-mode turns now opt into partial (streaming) assistant messages from
  herdctl (`@herdctl/core`/`@herdctl/chat` ≥ the herdctl#382 release): both
  `HerdctlService.chatSession` and `runCommand` pass `includePartialMessages: true`
  to `openChatSession`. The SDK then emits `stream_event` / `text_delta` chunks that
  `@herdctl/chat`'s translator surfaces as incremental `onText` calls, which the WS
  layer already forwards as `chat:response` `{ chunk }` frames — so a keeper reply
  now accretes into the live bubble token-by-token instead of landing in one drop.

  The transport was already delta-shaped (per-turn hub buffer, replay, and
  `ChatPane` chunk-append are delta-agnostic), so re-attach/replay is unchanged and
  no coalescing was needed. Only session-mode (SDK-runtime) instances benefit;
  batch-mode keeps whole-message rendering.

- [#313](https://github.com/edspencer/paddock/pull/313) [`92dc8c9`](https://github.com/edspencer/paddock/commit/92dc8c9c94af822926ec4b54e2e85aa8f7d97229) Thanks [@edspencer](https://github.com/edspencer)! - Add the unified **trigger** foundation (Epic T / T1): one discriminated `triggers`
  config block — `schedule | event | webhook` (the **when**) + a shared `run` (the
  **what**) + `enabled` — over the existing `startAgentTurn` execution core, collapsing
  what were separate hook and schedule declarations into one model. Adds `TriggerService`
  (the frozen CRUD registry T2–T5 build on) wiring **both** existing fire paths — the
  lifecycle event bus (`onArchive`) and herdctl's schedule trigger handler — through a
  single trigger fire path, plus a `TriggerSessionStore` sidecar that rebinds a
  `run.session: "resume"` trigger's owned chat after a restart. New triggers default
  `enabled: false`. No UI/REST/self-MCP surface yet (those are T3/T4); the webhook variant
  is shape-reserved only (no ingress — T6).

## 0.35.0

### Minor Changes

- [#302](https://github.com/edspencer/paddock/pull/302) [`4f83481`](https://github.com/edspencer/paddock/commit/4f834818da12e47954adf3a394755e497bcd1f1b) Thanks [@edspencer](https://github.com/edspencer)! - Configurable keeper-chat recovery — Phase 0 config + Layer 2 visibility/Continue (#301)

  When a keeper starts a background task (background `Bash` or a background
  `Task`/`Agent`) and ends its turn while it's still running, herdctl keeps the
  session alive but the SDK/native binary kills the child at the turn boundary — the
  `killed`/`stopped` `<task-notification>` emits no wake, so the keeper is left
  alive-but-idle-forever (root cause: edspencer/herdctl#374). This adds an app-side
  recovery mechanism.

  **Phase 0 — config foundation.** A new `recovery` config group on `PaddockConfig`
  (env `PADDOCK_RECOVERY_*`, YAML instance file, built-in defaults) plus an optional
  per-project `recovery` override in `project.yaml` (tri-state update: object sets,
  `null` clears, absent leaves untouched), resolved at dispatch (project ?? instance)
  — the same discipline as `driveMode`/`maxSpawnDepth`:

  - `surfaceKilledTask` — Layer 2, default **ON** (`PADDOCK_RECOVERY_SURFACE`)
  - `autoReDrive` — Layer 3, default **OFF** (`PADDOCK_RECOVERY_AUTODRIVE`; the
    detection/inject engine is a follow-up — this ships only the flag)
  - `debounceMs` (5000), `maxRetries` (1), `limboTimeoutMs` (0 = off)

  **Phase 1 — Layer 2 visibility + manual Continue (default ON).** A killed/stopped
  background-task notification now surfaces as a distinct amber "⚠ background task
  terminated at the turn boundary — the keeper is idle" affordance (no longer folded
  away), with a one-click **Continue** that injects a recovery nudge into the still-
  alive session via `startAgentTurn` (new `chat:continue` WS action). The nudge is
  attributed to a new `recovery` message sender and tells the keeper its task was
  KILLED AT THE TURN BOUNDARY (not "stopped by user", cf #216) so it re-runs in the
  foreground or reports.

  Layer 3 automatic recovery is a follow-up.

## 0.34.0

### Minor Changes

- [#296](https://github.com/edspencer/paddock/pull/296) [`1958f7d`](https://github.com/edspencer/paddock/commit/1958f7d6203c5447ac359caec0604ca461b2688b) Thanks [@edspencer](https://github.com/edspencer)! - Event hooks foundation: run an agent turn when a lifecycle event fires (Epic G / G1)

  A **hook** is an event-triggered agent turn. Each hook is registered as its own
  herdctl agent `hook-<slug>-<name>` — exactly how keeper/sweeper agents are registered —
  whose tool config (`allowed_tools`/`denied_tools`/`permission_mode`/`model`/`max_turns`)
  **is** its capability set. There is no hook "kind"/profile and no "curator" concept: a
  hook granted no tools is tool-less; a hook that must clean up is granted `Bash` and does
  the work itself.

  This ticket lands the blocking foundation the rest of Epic G builds on:

  - **Data model + persistence** — a per-project `hooks` map in `project.yaml`
    (`{ event, capabilities, prompt/promptFile, enabled }`), with keeper-editable prompt
    bodies in `.paddock/hooks/*.md` (git-tracked), mirroring the shipped
    `.paddock/schedules/*.md` pattern. New hooks default `enabled: false`.
  - **Hook CRUD service** (`HookService`: list/get/set/remove) — the shared surface the
    Hooks tab and hook-management MCP will consume — plus the pure `hook-config.ts`
    helpers (sanitize + capability→agent-config projection + prompt-file resolution).
  - **In-process event bus** — lifecycle events fire inside Paddock's own server
    (fire-and-forget, after-commit; a hook can never block or fail the triggering action).
  - **`onArchive` wired** as the first event: after a chat-archive commits (REST route or
    the self-MCP `archive_chat` tool), the dispatcher fires each of the project's enabled
    `onArchive` hooks via `startAgentTurn`, stamped `origin: hook`.

  Provenance is extended additively: a new `hook` chat origin and a `{ kind: "hook" }`
  message sender, so a hook run is attributable. No herdctl changes.

- [#299](https://github.com/edspencer/paddock/pull/299) [`ab0af75`](https://github.com/edspencer/paddock/commit/ab0af7579480558e4d44b84358bfddb2cd4501cb) Thanks [@edspencer](https://github.com/edspencer)! - Hook chat visibility: chat-list filter + hook badge + capability banner (Epic G / G3)

  Now that a hook (Epic G / G1) fires as its own `hook-<slug>-<name>` agent, its chats
  need to be visible and legible. G3 surfaces them:

  - **Generalized chat-list filter (GG-5)** — the old hard keeper-only listing becomes
    "every one of a project's agents EXCEPT the hidden ones": the keeper **and** every
    declared hook agent are listed, so hook chats appear in the sidebar alongside keeper
    chats. The **sweeper stays hidden** (its curation chats never surface — the
    `hideChats` case) and scratch is unchanged. `listSessions` merges the visible agents'
    sessions (deduped, mtime-sorted, fault-isolated per agent) via the new pure,
    unit-tested `visibleProjectAgentNames` helper.
  - **Hook badge (GG-5)** — a hook chat (`origin: hook`) gets a small lightning-bolt
    badge in the chat list, reusing the shipped provenance-badge surface (like the
    scheduled/spawned badges); the owning hook's name rides in the tooltip.
  - **Read-only capability banner (GG-6)** — opening a hook chat floats a sticky banner
    atop the message history stating it's a hook agent, its trigger event, and its
    **granted capabilities** (allowed/denied tools, permission mode, model, max turns,
    agent name), clickable for the exact tool list, with an affordance toward editing the
    hook. Because the descriptor is projected from the SAME registered agent config
    herdctl enforces (`ChatHookInfo`, rides on the chat DTO for hook chats only), the
    banner is **truthful by construction**. It is strictly read-only — no live permission
    escalation (deferred G7).

  No herdctl changes. The Hooks tab CRUD UI (G4) and hook MCP (G5) are separate tickets;
  the banner's edit link points at Settings as a placeholder until the Hooks tab lands.

## 0.33.0

### Minor Changes

- [#292](https://github.com/edspencer/paddock/pull/292) [`0c43326`](https://github.com/edspencer/paddock/commit/0c4332637a16e53b143b231ebc676193e1aba267) Thanks [@edspencer](https://github.com/edspencer)! - Per-message sender provenance: attribute machine-injected turns in chat history (#290)

  Chats now record WHO injected each machine-added turn — `send_message` from another
  chat, a schedule fire, or a spawn kickoff — and surface it per-message in the
  transcript. Human-typed messages stay unlabelled (the default); a machine-injected
  turn gets a subtle attribution above its bubble ("↩ sent by _⟨chat⟩_", linking to the
  sending chat, or "⏰ scheduled by _⟨name⟩_"). This is the per-message analog of the
  per-chat provenance badge (#261/#267), backed by a new `MessageProvenanceStore` sidecar
  joined into the message DTO by injected-content order.

  Also fixes the related live-streaming bug: an injected message now streams into an
  already-open recipient chat immediately (a new `chat:injected` WebSocket frame),
  instead of only showing the assistant's reply and requiring a manual refresh.

### Patch Changes

- [#294](https://github.com/edspencer/paddock/pull/294) [`2ed201c`](https://github.com/edspencer/paddock/commit/2ed201c77f9eb02b4430e8ddd214378847525d48) Thanks [@edspencer](https://github.com/edspencer)! - Cut the CPU cost of a streaming chat. While a turn streams, the only continuous
  work is a handful of 60fps CSS animations (two spinners + a ping) — measured with
  0 JS long-tasks and ~1 DOM mutation/sec — which on a large/Retina display can pin
  the OS compositor near 50% for the whole turn. The "working" spinners now use a
  stepped, layer-isolated `spin-eco` (~10fps instead of 60) rather than a smooth
  `animate-spin`; the streaming caret hard-blinks instead of a smooth opacity pulse;
  the redundant `animate-ping` dot is dropped; and all of these honor
  `prefers-reduced-motion` and pause while the tab is backgrounded.

## 0.32.0

### Minor Changes

- [#288](https://github.com/edspencer/paddock/pull/288) [`6f37264`](https://github.com/edspencer/paddock/commit/6f37264e20a8718123958b1447bde7a8610b67cc) Thanks [@edspencer](https://github.com/edspencer)! - Run-history "while you were away" view (#268).

  Ticket E3 of the Events / Schedules / Config initiative — visibility for the runs
  that happen when nobody is watching. A new project-level **History** tab lists
  recent keeper runs with their **provenance** (human / scheduled / spawned), so the
  unattended work (a cron-fired schedule, a chat spawned by another chat) is easy to
  find, review, and open. Builds on the A1 provenance marker (#261 / DD-3), the E1
  badges (#267), and D3 scheduled sessions (#265).

  - **Data source.** `HerdctlService.listProjectRuns` reads herdctl job records via
    `@herdctl/core`'s `listJobs`, filtered to the project's keeper agent (so
    scratch/sweeper runs are excluded), newest-first. Each record carries timing
    (`started_at`/`finished_at`/`duration_seconds`), `status`, `session_id`, and the
    schedule/fork that triggered it.
  - **Provenance join.** A new pure, unit-tested builder (`buildProjectRuns`) joins
    each run with the `RunProvenanceStore` marker keyed by `session_id`, so
    scheduled + spawned runs report their **true** origin and spawn depth.
    Paddock-initiated turns still persist `trigger_type:"manual"` on the job record,
    so origin lives in the provenance store, not the enum — the builder is the
    authoritative join.
  - **"Since last login" digest.** `GET /api/projects/:slug/runs` folds in a
    per-user "runs last seen" watermark (reusing the `ReadStateStore` / #189
    read-state plumbing under a reserved sentinel session id), flags each run
    `isNew`, and counts new **unattended** runs. The History tab shows a count badge
    and a "N new runs ran while you were away" banner; opening the tab advances the
    watermark (`POST .../runs/seen`, monotonic).
  - **UI.** `HistoryPane` matches Paddock's design system (provenance-colored origin
    chips, status chips, relative time + duration, schedule/parent trigger note),
    defaults to an "Unattended" filter with an "All" toggle, and links each run into
    its chat.
  - **Cost is deferred (P3).** herdctl does not yet persist per-run token accounting
    (X1/#378 + X2/#271), so a documented cost seam (`RunSummary.cost`, always
    `null`; an em-dash column) is left where per-run cost will slot in without a wire
    change.

  Note: session-mode turns (`openChatSession`) write no herdctl job record, so runs
  driven that way don't appear here — only batch `trigger()` turns and the synthetic
  adoption records do (a pre-existing, documented herdctl limitation, same as the
  unread `lastTurnCompletedAt` signal).

- [#287](https://github.com/edspencer/paddock/pull/287) [`aaec79b`](https://github.com/edspencer/paddock/commit/aaec79ba0e604a623017c5bb662348ced52f948f) Thanks [@edspencer](https://github.com/edspencer)! - Per-project schedules management UI (#266).

  Ticket D4 of the Events / Schedules / Config initiative — the Settings-pane surface
  that completes scheduled chats. A new **Schedules** section in each project's
  Settings tab lists that project's scheduled chats (name, cron/interval expression,
  new-vs-accrete session mode, enabled state, live status + last/next run merged from
  herdctl's runtime) and lets an operator create, edit, delete, enable/disable, and
  **trigger now** — all wired to the D3 server surface (`ProjectStore.set/removeSchedule`

  - herdctl's `setAgentSchedule`/`removeAgentSchedule`/`enable/disableSchedule`).

  * **New REST surface** under `/api/projects/:slug/schedules`: `GET` (declaration +
    runtime state + the `mutationEnabled` gate), `PUT :name` (create/replace), `DELETE
:name`, `POST :name/(enable|disable)`, and `POST :name/trigger`. Each mutating
    route persists to `project.yaml` first (source of truth — re-arms on restart), then
    arms herdctl at runtime via the granular D3 APIs.
  * **Trigger-now** fires the schedule through the SAME `startAgentTurn` hub path a
    cron fire uses (D3), so a manual run shows up as a first-class, discoverable,
    `scheduled`-badged chat (E1/#267) — never `isSidechain`-hidden. `makeChatHandler`
    now exposes its schedule-fire entrypoint so the route can reuse it; the cron and
    manual paths share one implementation.
  * **Respects the per-deployment mutation gate** (`PADDOCK_SCHEDULE_MUTATION`, DD-7):
    when off, the mutating routes return 403 and the pane renders read-only with a
    hint, while listing and trigger-now (which runs an already-declared schedule)
    stay available.

  Tests: integration against the real FleetManager + scheduler + CLI runtime (list /
  create / edit / enable-disable / delete / trigger-now → a scheduled chat appears;
  validation 400s; the gate-off 403 + read-only + still-triggerable case) plus web
  component coverage of the Schedules section.

## 0.31.0

### Minor Changes

- [#281](https://github.com/edspencer/paddock/pull/281) [`dee88b6`](https://github.com/edspencer/paddock/commit/dee88b623d3abc0578cc936f05dd2d306ba29cf6) Thanks [@edspencer](https://github.com/edspencer)! - Fork chat: name the fork before creating it (#279)

  The fork button used to fork eagerly on click, always titling the copy
  "Fork of <parent>". It now opens a small naming dialog first — a single text
  input prefilled with that default, auto-focused and fully selected so the user
  can hit Enter to accept it or start typing to replace it.

  - New `ForkChatModal` follows the existing modal convention (centered card,
    backdrop, Escape-to-close). Enter submits, Cancel/Escape closes without
    forking. A whitespace-only name falls back to the default.
  - `ProjectView` opens the dialog instead of forking immediately; the actual
    fork still records lineage (`writeForkParent`) and navigates with
    `justForked` so the composer auto-focuses to continue the new chat.

- [#277](https://github.com/edspencer/paddock/pull/277) [`d7dd860`](https://github.com/edspencer/paddock/commit/d7dd860b5838f9c25ff73c585b58405d3b04b7a5) Thanks [@edspencer](https://github.com/edspencer)! - Chat list: provenance badges for scheduled / spawned chats (#267)

  Surfaces A1's provenance marker (#261) on the per-project chat list so the "ran
  without me" cases are legible at a glance.

  - The chat DTO now carries `provenance` (`origin` + spawn `depth`), read from the
    `RunProvenanceStore` sidecar in both the project-detail and chat-list payloads
    (and scratch chats), mirroring how the archived flag is threaded.
  - The chat-list row renders a small, subtle icon badge for `scheduled` (a schedule
    fired it) and `spawned` (another chat created it) origins, following DD-6's reuse
    of herdctl's trigger-type icons. `human`-origin chats — the default — render no
    badge, so only the unattended runs stand out.

- [#278](https://github.com/edspencer/paddock/pull/278) [`6e54523`](https://github.com/edspencer/paddock/commit/6e54523ba2983280d170d6e01e65b6a6a29ff1e1) Thanks [@edspencer](https://github.com/edspencer)! - Depth-gated self-MCP injection for spawned chats — a spawned child can now report back to its parent (#262).

  Ticket B1 of the Events / Schedules / Config initiative, building on the origin+depth
  provenance marker from #261. Previously a spawned chat was injected with `send_file`
  ONLY, so it had no `send_message` tool and could never report back to the chat that
  spawned it (recursion was prevented by omission, not by a real bound). Now the
  self-management MCP — **including its write tools** — is injected into a spawned turn
  based on the chat's stamped spawn `depth`:

  - A spawned/scheduled turn running in a chat at depth `d` receives the self-MCP iff
    `d <= maxSpawnDepth`. When a tool-equipped child itself spawns, its children are
    stamped one hop deeper, so the bound descends and the tree can't run away.
  - New config `maxSpawnDepth` — an instance default (`PADDOCK_MAX_SPAWN_DEPTH`) with a
    per-project override in Settings (the `driveMode` inherit/override pattern). **Default
    `1`**: a manager's direct children get the write tools (report-back + spawn), but
    depth-2 grandchildren do not. `maxSpawnDepth = 0` restores exactly today's behaviour
    (no spawned child gets the self-MCP — `send_file` only).

  The human/scheduled root (depth 0) is unchanged — it keeps today's instance-flag gating
  (`selfMcpEnabled` / `selfMcpWriteEnabled`). Internally the inline self-MCP builder is
  extracted into one helper shared by the human and spawned paths, and the exact gate is a
  small pure module (`spawn-capability.ts`) with full unit coverage.

  Also fixes a latent break this ticket surfaced: the server-initiated spawn path passed
  `triggerType: "agent"`, which is not a member of herdctl's `TriggerTypeSchema` enum, so
  every `create_chat` / `fork_chat` / `send_message` job failed validation and no child was
  ever created. It now passes the valid `"manual"` value (provenance is carried separately
  by the origin+depth marker).

## 0.30.0

### Minor Changes

- [#273](https://github.com/edspencer/paddock/pull/273) [`9803635`](https://github.com/edspencer/paddock/commit/9803635a69308ccafb132f2b6637813009666f5c) Thanks [@edspencer](https://github.com/edspencer)! - Changes tab: selective per-file commit, diff stat, and a projects-grid dirty nudge (#258)

  - The Changes tab now has a checkbox per changed file (with select-all/none) and a "Commit N selected" action, so you can commit a subset instead of the previous all-or-nothing commit. `GitService.commitProject` gains an optional project-relative `paths` list (validated to stay inside the subtree); the commit endpoint accepts `files[]`.
  - Each changed file shows a `+A −R` line stat (from `git diff --numstat` for tracked changes, all-added line counts for untracked text files, "binary" for binary), echoed in a diff stat header.
  - The projects grid now flags each project's uncommitted-file count, fed by a single cheap `git status` rollup on `/api/projects` — so pending work is visible before opening a project.

- [#272](https://github.com/edspencer/paddock/pull/272) [`968a449`](https://github.com/edspencer/paddock/commit/968a4495f67633ca3c6264534d9db1ea67c9e019) Thanks [@edspencer](https://github.com/edspencer)! - Files tab: browse subdirectories with nested, deep-linkable URLs (#259)

  The Files tab previously listed only top-level files, so anything a project filed
  under a subdirectory (e.g. `design/`, `aar/`, `docs/`) was invisible. The listing
  now returns one directory level at a time with a per-entry kind (file vs dir), and
  the Files tab lets you click into folders. The current directory or file is
  carried in a nested `/projects/:slug/files/<path>` URL (deep-linkable and
  refresh-safe), with a `..` entry to go up and a path breadcrumb. Directories are
  visually distinguished and sort ahead of files. The traversal guard stays central
  in `resolveInProject`, and the single-file read path already supported nested
  names.

## 0.29.0

### Minor Changes

- [#254](https://github.com/edspencer/paddock/pull/254) [`f6a5271`](https://github.com/edspencer/paddock/commit/f6a5271cbcc08c746eb30aa419d13c5137530bf2) Thanks [@edspencer](https://github.com/edspencer)! - Render Paddock's own MCP tools as first-class UI (#253). Every `mcp__…` tool now
  shows a humanized name (e.g. `mcp__paddock_manage__create_chat` → "Create chat")
  plus a brand badge/icon instead of the raw name. The seven `paddock_manage`
  tools additionally get dedicated bodies parsed from their JSON output: project
  chips, a chat list with live running dots, a transcript preview, a fan-out list
  of child prompts for `fork_chat_batch`, and — for `create_chat` / `fork_chat` /
  `send_message` — the chat's real name/title and the kickoff prompt or sent
  message (the write tools now echo `name`/`prompt` into their result payload so
  this renders both live and on reload). Results link straight into the chats they
  touched (`/projects/:slug/chat/:sessionId`). Parsed client-side like `send_file`.

## 0.28.0

### Minor Changes

- [#246](https://github.com/edspencer/paddock/pull/246) [`d984495`](https://github.com/edspencer/paddock/commit/d98449595ff82394add77a45fe6dccbc441d6cb3) Thanks [@edspencer](https://github.com/edspencer)! - Make the queued-message auto-send server-authoritative (#245). Previously the send was driven by the client (`ChatPane` flushed on a live `chat:complete`), so a queued message stranded if the socket dropped across the turn boundary, and could double-send when both the client and the server backstop fired. Now the server owns draining: it auto-sends a persisted queued message both at turn completion and immediately when a queue is set for an idle session (covering a queue delivered late over the reconnect outbox). An atomic `QueuedMessageStore.take()` plus a client-stamped message timestamp make the drain exactly-once (no double-send, including a stale copy a reloaded client re-asserts). The client no longer self-sends — it persists the queue, and renders the sent bubble + clears its copy when the server broadcasts `chat:queued_flushed` (now reaching a reconnected socket via the hub). Queued slash commands are routed through the command path.

## 0.27.1

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

### Minor Changes

- [#233](https://github.com/edspencer/paddock/pull/233) [`02cd64e`](https://github.com/edspencer/paddock/commit/02cd64efb1c6da3a76e0bf7eaaf151c3dc0f4a44) Thanks [@edspencer](https://github.com/edspencer)! - Render `Edit`/`MultiEdit`/`Write` tool calls as an inline diff (issue #232).
  Edit tool calls previously showed only the file path + a generic success line; you
  couldn't see what changed. The before/after is now recovered server-side from the
  raw `tool_use.input` (which herdctl's parser drops), turned into a compact
  line-level diff, and rendered in the tool block with `+`/`−` green/red coloring —
  a filename + `+A −D` stat in the header, the colored diff on expand. `MultiEdit`
  shows one labelled hunk per sub-edit; `Write` renders as all-additions. Enrichment
  mirrors the sub-agent/background reader (raw-input recovery + positional join); no
  herdctl change and no diff dependency. History-hydrated only (like #230), so live
  edits get the diff on reload.

## 0.24.0

### Minor Changes

- [#231](https://github.com/edspencer/paddock/pull/231) [`b8ac5a1`](https://github.com/edspencer/paddock/commit/b8ac5a182df5fd8a99d0fa65eed7eea675dcc1e5) Thanks [@edspencer](https://github.com/edspencer)! - Render background jobs & Monitor as a first-class tool class (issue #230).
  Background `Bash` (`run_in_background`), `Monitor`, and the background-task ops
  (`BashOutput`/`TaskOutput`/`TaskStop`) now render with a "background" badge, a
  clock icon, and a status chip (running / completed / killed / persistent). The
  launching call is linked to its result by task id: a background `Bash` shows its
  final status + completion summary inline, and a `Monitor`'s streamed events are
  grouped under its block instead of scattered as separate notification pills.
  Enrichment is server-side (`background.ts`, mirroring the sub-agent path); the
  live path falls back to output-sniffing so the badge still shows before reload.

### Patch Changes

- [#226](https://github.com/edspencer/paddock/pull/226) [`b40ea43`](https://github.com/edspencer/paddock/commit/b40ea43b32b47a82976e53d225256bb22b2ad977) Thanks [@edspencer](https://github.com/edspencer)! - fix(web/PWA): version the service-worker cache per build and stop it masking auth / poisoning asset URLs (#221)

  The hand-rolled service worker never invalidated across deploys (`CACHE_VERSION`
  was a hardcoded constant) and served its cached app shell on _any_ non-OK
  navigation — masking SSO login redirects and wedging the app on a stale shell
  after an auth lapse. It could also cache an HTML document (a mis-served
  `index.html`) under an asset URL. Now: `CACHE_VERSION` is stamped at build time
  (pkg version + bundle hash) so every deploy activates a fresh cache and purges the
  old one; navigations pass 401s/redirects through (cached shell only when truly
  offline); HTML is never cached under, nor served for, an asset URL; and a newly
  activated build reloads the tab once (`controllerchange`, guarded against loops).

- [#228](https://github.com/edspencer/paddock/pull/228) [`f140b31`](https://github.com/edspencer/paddock/commit/f140b31a0e567bf5bbfae50090b79f75191932ba) Thanks [@edspencer](https://github.com/edspencer)! - fix(web): recover from a failed lazy-route import instead of dead-ending (#222)

  The code-split routes are loaded via `React.lazy(() => import(...))`, but the
  router had no `errorElement`, so a rejected chunk import (a stale hash after a
  deploy, or a transient auth/network blip) dead-ended at React Router's default
  "Unexpected application error" screen. A root `errorElement` now detects
  chunk-load / module-script failures and reloads once onto the current build
  (guarded via sessionStorage against reload loops); genuine errors — or a chunk
  error that already survived a reload — get a friendly error card with a manual
  reload.

- [#227](https://github.com/edspencer/paddock/pull/227) [`1b01df7`](https://github.com/edspencer/paddock/commit/1b01df7cf3b704b80d7239b13a1c951587954bde) Thanks [@edspencer](https://github.com/edspencer)! - Shrink the Projects dashboard padding on mobile. The landing grid wrapped in
  `px-8 py-10` at every width, spending 64px (16% of a 390px phone) on side
  gutters. It's now responsive — `px-3 py-5` on XS, restoring `px-8 py-10` at the
  `sm` breakpoint and up.

## 0.23.0

### Minor Changes

- [#215](https://github.com/edspencer/paddock/pull/215) [`509c445`](https://github.com/edspencer/paddock/commit/509c4450738eb6af74c3cfb7642c2199df59e8b6) Thanks [@edspencer](https://github.com/edspencer)! - Add the read-only Paddock self-management MCP (issue #214, Phase 1). When `PADDOCK_SELF_MCP` is set, keeper turns are handed a `paddock_manage` MCP server exposing three read-only tools — `list_projects`, `list_chats` (cross-project), and `read_chat` (a trimmed, length-capped transcript tail) — so a keeper can inspect Paddock itself. Injected via herdctl's `injectedMcpServers` (same mechanism as `send_file`); keeper-only (never scratch) and off by default. Write tools (create/fork/message) and the external bridge are later phases.

- [#218](https://github.com/edspencer/paddock/pull/218) [`050c3d3`](https://github.com/edspencer/paddock/commit/050c3d3903ec7c2b022b1872cd8fd707a4bd5bb9) Thanks [@edspencer](https://github.com/edspencer)! - Add the Paddock self-management MCP **write tools** (issue #214, Phase 2). Behind the new `PADDOCK_SELF_MCP_WRITE` flag (on top of `PADDOCK_SELF_MCP`), keeper turns additionally get `create_chat`, `fork_chat`, `send_message`, and `fork_chat_batch` (fan-out) on the `paddock_manage` MCP server.

  Each starts a real keeper turn routed through the shared SessionHub, so a spawned chat appears in the sidebar, flips the running indicator, streams live, and is re-attachable — full parity with a human-started turn. `fork_chat_batch` (cap 20) is the fan-out primitive: fork the current chat N times, one kickoff directive per line, run concurrently. Keeper-only; off by default; gated separately from the read tools because these start real work.

  Containment: spawned turns get `send_file` only, not the self-MCP, so an automated fan-out cannot recurse into a fork bomb (a spawned chat regains the tools only when a human later drives it). No explicit recursion guard is built this phase (per #214); the injection path stays guard-ready.

  Fork kickoffs are framed so a forked child treats the inherited (possibly mid-turn) transcript as context and runs its directive instead of inheriting the parent's identity. `fork_chat_batch` takes its list as newline/JSON text (the CLI-runtime MCP transport drops array-typed args). `fork_chat`/`send_message` validate the target session and return a clean "chat not found" instead of a raw ENOENT / false success.

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

- [#203](https://github.com/edspencer/paddock/pull/203) [`1812631`](https://github.com/edspencer/paddock/commit/18126311c66089f4b6c51e7194e8534b749ebc73) Thanks [@edspencer](https://github.com/edspencer)! - Fix mobile input focus-zoom and add safe-area chrome. iOS Safari auto-zoomed
  (and broke the fixed 100dvh layout) whenever a sub-16px input/textarea was
  focused; form controls are now 16px on small screens, so focus-zoom is
  prevented without disabling pinch-to-zoom. Also adds `viewport-fit=cover` with
  `env(safe-area-inset-*)` padding on the mobile top bar and composer (no longer
  tucked under the notch / home indicator), removes the grey tap-highlight flash
  on interactive controls, and sets `autoCapitalize="sentences"` on the composer.

- [#204](https://github.com/edspencer/paddock/pull/204) [`89b2710`](https://github.com/edspencer/paddock/commit/89b271088464b9cf45cece5f68ae3cbad2280e85) Thanks [@edspencer](https://github.com/edspencer)! - fix(web): persist the queued message so it survives a chat switch / reload (#197)

  The message queue (#91) kept its single stacked follow-up only in component-local
  React state, so navigating away from a chat and back — or refreshing — silently
  dropped it (surprising, since the composer draft right beside it already
  persists). The queued message is now stored per-chat in localStorage, keyed like
  the draft (`new:<slug>` before a session id exists, the session id after),
  hydrated when the pane remounts, and forgotten when the queue flushes / is edited
  / is cleared. A restored queue still auto-flushes on the next completed turn.

- [#198](https://github.com/edspencer/paddock/pull/198) [`47cb6eb`](https://github.com/edspencer/paddock/commit/47cb6ebe198d9de0b30fbdbb37341e06f2001093) Thanks [@edspencer](https://github.com/edspencer)! - fix(web): Stop button is a silent no-op when clicked in the pre-arm window (#196)

  The composer flips Send → Stop the instant a turn starts streaming, but the
  client could only send `chat:cancel` once it knew the turn's `jobId` — which the
  server round-trips a beat later (via the first frame / `chat:active`). Clicking
  Stop in that gap silently did nothing: no cancel was sent and the turn ran to
  completion. The window is usually 1–5s but can stretch to ~12s on a new chat's
  first turn under load.

  Now a Stop clicked before the jobId is known is _deferred_: the intent is
  remembered and the cancel fires the instant the jobId arrives. Also nulls
  `jobRef` at the start of every turn so a Stop in turn 2+'s pre-arm window can't
  fire `chat:cancel` against the previous turn's already-finished job id (a
  server-side no-op that left the new turn running).

## 0.21.1

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

- [#191](https://github.com/edspencer/paddock/pull/191) [`16b6332`](https://github.com/edspencer/paddock/commit/16b63326db4e0787a53682637ffcc2b463b42999) Thanks [@edspencer](https://github.com/edspencer)! - Stop rendering internal `<task-notification>` blocks as raw-XML chat bubbles (#181). When a background agent (Task/Agent tool) stops or completes, the Claude Code harness injects a `<task-notification>` block as a synthetic `role:"user"` transcript entry. It isn't flagged `isMeta:true`, so it survives `@herdctl/core`'s parser and used to render as a raw-XML user bubble on reload. Paddock now detects it (like the #106 compaction/slash-command artifacts) and renders a subtle, centered system-status line carrying the human-readable `<summary>` (full text on hover) instead.
  </content>

## 0.20.0

### Patch Changes

- [#162](https://github.com/edspencer/paddock/pull/162) [`8f74dfa`](https://github.com/edspencer/paddock/commit/8f74dfaac7d8c7e1b6caaa892e61148d651fe00f) Thanks [@edspencer](https://github.com/edspencer)! - Render CC's post-`/compact` transcript artifacts as clean markers instead of raw user bubbles (#106). The `<command-name>…</command-name>` slash-command echo now shows as a compact `/compact` chip, and the "This session is being continued…" continuation summary renders as a "🗜️ conversation compacted" boundary with the machine-generated summary tucked behind a disclosure — so a compacted chat no longer looks corrupted (it could previously even end on a stray user-styled summary bubble).

- [#163](https://github.com/edspencer/paddock/pull/163) [`190f335`](https://github.com/edspencer/paddock/commit/190f335bdc4697b30f9b7b837c0f32eee31ed6e9) Thanks [@edspencer](https://github.com/edspencer)! - Keep the open chat's sidebar row even when it's momentarily missing from the chat list (#154). The post-turn sweep can transiently steal a live keeper chat's `session_id` (its job gets stamped `sweeper-<slug>`), so `getAgentSessions("keeper-<slug>")` filters that chat out until the next keeper turn re-attributes it — the chat flickers out of the sidebar though it's open and intact (upstream root cause: herdctl#357). `ProjectView` now renders a fallback row for the open `activeSession` when it's absent from the list, preferring its last-seen DTO (real name, ring, actions) and falling back to a minimal "Current chat" row on a cold load, so an open chat can never be left rowless.

## 0.19.2

### Patch Changes

- [#169](https://github.com/edspencer/paddock/pull/169) [`02f2d89`](https://github.com/edspencer/paddock/commit/02f2d891622fc089ee14dc09a683f36935243b4d) Thanks [@edspencer](https://github.com/edspencer)! - Auto-focus the composer textarea when starting a New Chat, so you can type immediately (#159).

- [#174](https://github.com/edspencer/paddock/pull/174) [`f32d424`](https://github.com/edspencer/paddock/commit/f32d42440f80e82c56675f82c4c9364a0a038454) Thanks [@edspencer](https://github.com/edspencer)! - Show a brand-new chat's context-usage ring in the chat list immediately after its first turn, instead of only after a full page refresh (#164). The ring is now seeded from the live `chat:complete` usage the pane already holds, so it no longer depends on a same-instant, mtime-memoized disk re-read that can race and omit the new session.

- [#172](https://github.com/edspencer/paddock/pull/172) [`ff84e5d`](https://github.com/edspencer/paddock/commit/ff84e5dece1c34a62924eecae8fc353d5f3227df) Thanks [@edspencer](https://github.com/edspencer)! - Sidebar per-project badges: unread-reply count + in-flight count, replacing the per-row StatusPill (#161)

- [#170](https://github.com/edspencer/paddock/pull/170) [`4ebea5f`](https://github.com/edspencer/paddock/commit/4ebea5ff9a9c82a1e70f3e454d3bf68ce8e18dfa) Thanks [@edspencer](https://github.com/edspencer)! - Show a sub-agent's estimated API-rate cost (USD) next to its duration in the expandable sub-agent block, priced per-model from the sub-agent's own transcript (#166)

- [#171](https://github.com/edspencer/paddock/pull/171) [`13a2ff8`](https://github.com/edspencer/paddock/commit/13a2ff85b3e50031253ca04174da9cd31abfb9e5) Thanks [@edspencer](https://github.com/edspencer)! - Add a subtle "unread" affordance to per-project chat rows: a chat is marked unread when the agent finishes a turn while the user isn't viewing it, and read when opened/focused. Adds a `lastTurnCompletedAt` chat DTO field sourced from herdctl job records (#160).

## 0.19.1

### Patch Changes

- [#156](https://github.com/edspencer/paddock/pull/156) [`b57d7d9`](https://github.com/edspencer/paddock/commit/b57d7d980388d5a0bf4bf00854a27ccfaf318082) Thanks [@edspencer](https://github.com/edspencer)! - fix(web): roll back transcript virtualization (broken scrolling); keep memoized TurnView

  The react-virtuoso windowing added in #148 broke scrolling back through history on
  real, variable-height chats (markdown, code blocks, tool blocks). As tall bubbles
  were measured on scroll, Virtuoso's total height estimate kept ballooning (measured
  ~22k → ~37k px on a 350-turn chat) and the scroll position jumped — scrolling _up_
  would snap the viewport _down_. Initial open was fine, but reading history was
  janky/unusable.

  Reverted to the plain, reliable transcript list (single scroll container, stable
  scroll height, precise scroll position) and removed the `react-virtuoso`
  dependency. **`React.memo(TurnView)` is kept** — it's the change that fixes
  composer-typing / streaming lag and is unaffected by the scrolling problem. The
  large-chat open cost this was meant to address is now largely covered by the
  server-side wins in 5.19.1 + Paddock #147 (message/subagent mtime caches), so the
  plain list performs acceptably while scrolling correctly.

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

- [#150](https://github.com/edspencer/paddock/pull/150) [`67f8967`](https://github.com/edspencer/paddock/commit/67f89671e457b4ab8099a58ee50c1e57c74a866d) Thanks [@edspencer](https://github.com/edspencer)! - perf(web): virtualize large chat transcripts + memo TurnView (large-chat render + typing lag)

  The chat transcript rendered every turn into the DOM at once and the per-turn
  component was not memoized, so a large chat (a ~500K-token chat is 1000+ turns)
  mounted tens of thousands of DOM nodes in one layout on open, and every unrelated
  state change (typing in the composer, each streaming chunk) reconciled the whole
  transcript.

  - `TurnView` is now `React.memo`'d. `turns` are rebuilt only when the message list
    changes, so composer/stream/slash-menu state churn no longer reconciles unchanged
    turns — O(N)-per-keystroke becomes O(changed).
  - Large chats (> 80 turns) now window the transcript with react-virtuoso, rendering
    only on-screen turns; initial open + scroll no longer scale with total turn count
    in the DOM. Pin-to-bottom (on open and during streaming) is preserved via
    Virtuoso's `followOutput` + `initialTopMostItemIndex`. Small chats keep the exact
    plain-map path, so behaviour is unchanged for the common case.

## 0.18.3

## 0.18.2

### Patch Changes

- [#143](https://github.com/edspencer/paddock/pull/143) [`b4b9503`](https://github.com/edspencer/paddock/commit/b4b9503aa2f684adc4290728d288e504db7f9812) Thanks [@edspencer](https://github.com/edspencer)! - Fix concurrent new chats fusing together (#142).

  Starting a second new chat while the first was still streaming its opening turn could queue the second message into the first chat's live turn — fusing the two — and create no second chat in the sidebar. Two web-side defects:

  - **Pane reuse during the establish race** (`ProjectView`): the `ChatPane` remount key was derived only from `routeSessionId` transitions. A brand-new chat mirrors its learned session id into the URL asynchronously (`/chat` → `/chat/:id`, `replace`); clicking **New Chat** before that landed left `routeSessionId` null, so the key didn't bump and the still-streaming pane persisted — the next message was queued into that live turn. New Chat now forces a genuinely fresh pane via a nonce, independent of the establish race.
  - **Straggler frame leak** (`ws.route()`): a still-streaming chat whose pane had unmounted had its frames (a _known_ session id) handed to a freshly-mounted new-chat subscription. Known session ids are now tracked, and a frame for a known session with no live subscriber is dropped rather than routed to a nascent new-chat pane; a brand-new chat's own (as-yet-unknown) first session reveal still reaches it.

  No server or protocol changes.

## 0.18.1

### Patch Changes

- [#140](https://github.com/edspencer/paddock/pull/140) [`86a4895`](https://github.com/edspencer/paddock/commit/86a4895fe053fb24aa505ae61676bf163ff1a31e) Thanks [@edspencer](https://github.com/edspencer)! - Add a hover/focus action bar and an image lightbox to sent media embeds (#137).

  Sent **images** and **PDFs** now surface a small bottom-right cluster of icon
  actions over the embed:

  - **Download** (`<a download>`, same-origin so it keeps the original filename),
  - **Open in new tab** (`GET /api/chat-files/:id` already serves the attachment
    inline and is directly openable — no server work), and
  - **Maximize** (images only) → a full-viewport **lightbox** portaled to
    `<body>`: the image at up to the window size with the filename + the agent's
    caption beneath it, **Esc** / backdrop-click to close, scroll-lock while open.

  The cluster reveals on hover/focus on hover-capable devices and stays visible on
  touch (reusing the `can-hover` Tailwind variant). PDFs omit Maximize — the
  native `<object>` viewer already offers fullscreen/print/save, so open-in-new-tab
  is the cross-browser pop-out. Everything keys off the existing `file.rawUrl`.

- [#138](https://github.com/edspencer/paddock/pull/138) [`4a121b6`](https://github.com/edspencer/paddock/commit/4a121b6dd43863833db5c316af86d45d45b8692d) Thanks [@edspencer](https://github.com/edspencer)! - Give reloaded transcript turns a stable, reload-safe id derived from the source message's uuid (#135).

  Every rendered `Turn` previously got an in-memory render counter (`t${n}`) that was reassigned on each render, so nothing could remember state about a specific message across reloads. Now:

  - **Server:** bump `@herdctl/core` to a version that surfaces `ChatMessage.uuid` (the Claude Code JSONL per-entry uuid; herdctl#312). It flows through the messages endpoint unchanged (the `EnrichedMessage` DTO inherits it and `enrichWithSubagents` preserves it).
  - **Web:** `HistoryMessage` gains an optional `uuid`, and `historyToTurns` keys each turn's id on it. A single JSONL entry can yield sibling messages that share one uuid (text + tool_use, or multiple tool_uses), so the 2nd+ sibling is suffixed `#<n>` to keep React keys unique while staying deterministic. Messages without a uuid (older transcripts) fall back to the render counter.

  This is the foundation for per-message UI state that persists across reloads (e.g. resizable transcript items, #136). No visible behavior change on its own.

- [#141](https://github.com/edspencer/paddock/pull/141) [`3f62d63`](https://github.com/edspencer/paddock/commit/3f62d63412dfb8baa045b5e8371316539a9bd612) Thanks [@edspencer](https://github.com/edspencer)! - Bound + resize long sent-file text embeds, with a per-item height that persists across reloads (#136).

  A long sent-file **code / text / markdown** embed (e.g. a 500-line code file) previously rendered every line inline and dominated the transcript. Now such an embed is wrapped in a `ResizableBox`:

  - **Bounded by default:** content taller than 360px gets a fixed height with an internal scroll; shorter content is untouched (no fixed height, no scrollbar, no handle).
  - **Resizable:** a subtle drag handle along the bottom edge (pointer-capture drag, double-click to reset, ArrowUp/ArrowDown to nudge) lets you set a custom height per embed.
  - **Persisted:** the chosen height is saved to `localStorage` (device-sticky) and restored on render, so it survives chat switches and page reloads. The key is the file's own stable identity — a real file's immutable attachment id (from `rawUrl`), or a content hash for an inline send — which is byte-for-byte identical live and after a reload (unlike the transcript `turn.id`, which is an ephemeral counter on a freshly-sent turn and only becomes the stable uuid once reloaded).

  `html` (iframe), `mermaid`, `image`, `pdf`, and `video` embeds are unchanged. Web-only; no server changes.

## 0.18.0

### Minor Changes

- [#130](https://github.com/edspencer/paddock/pull/130) [`3d50354`](https://github.com/edspencer/paddock/commit/3d503546c87c1bd914751ee97524d802c19091e6) Thanks [@edspencer](https://github.com/edspencer)! - Add a per-project **Settings** tab (`/projects/:slug/settings`) as the canonical place to view and edit every project setting, replacing the cramped `EditProjectModal` (now retired). Settings are grouped and documented — Identity & metadata (name, summary, status, area, visibility, domain tags, labelled links, plus read-only slug/started/created), Keeper agent (model with context-window note, permission mode with a `bypassPermissions` caution, max turns, Docker sandbox, drive mode), and read-only Derived state (overview, pinned files). All "Edit" affordances now deep-link to the tab.

  `driveMode` shows its inherited-vs-overridden state: "Global default" surfaces the box-wide `PADDOCK_KEEPER_DRIVE_MODE` (newly exposed on `GET /api/models` as `keeperDriveModeDefault`), and an override can be reset back to inherit. Clearing now actually works end-to-end — `PATCH /api/projects/:slug` accepts `driveMode: null` to delete the override (a plain omitted/`undefined` field could never clear a persisted value).

## 0.17.1

### Patch Changes

- [#129](https://github.com/edspencer/paddock/pull/129) [`70d45bd`](https://github.com/edspencer/paddock/commit/70d45bd021ddc337a041580d0a3ed08e02e753c0) Thanks [@edspencer](https://github.com/edspencer)! - feat: theme-aware syntax highlighting for agent-sent code (#127)

  Code that the agent shares via `mcp__paddock__send_file` with `kind: "code"`
  now renders with syntax highlighting instead of plain monospace. A new shared
  `CodeBlock` component lazy-loads highlight.js (`highlight.js/lib/core` +
  a curated grammar set matching the send-file MCP's inferable languages) so the
  highlighter stays out of the entry chunk. Tokens are colored with hand-written
  `.hljs-*` CSS keyed to the Paddock palette for a matched light + dark scheme;
  the raw code renders immediately (no flash) and upgrades once the chunk
  resolves, falling back to plain text for unknown languages or load failures.

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

### Patch Changes

- [#124](https://github.com/edspencer/paddock/pull/124) [`ea5e3f2`](https://github.com/edspencer/paddock/commit/ea5e3f2037ec93edac231555b96fb838263fd5e4) Thanks [@edspencer](https://github.com/edspencer)! - Fix voice dictation on touch devices: after tapping stop, iOS Safari's sticky `:hover` kept the mic button showing a stop icon (with the recording tint) instead of the transcribing spinner, so it looked like nothing was happening. Hover-only affordances on the dictation button are now gated behind a new `can-hover` Tailwind variant (`@media (hover: hover)`).

## 0.16.0

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

- [#117](https://github.com/edspencer/paddock/pull/117) [`c63d089`](https://github.com/edspencer/paddock/commit/c63d08998d74c8fb497d1fcdba2b3fb4704cd4bd) Thanks [@edspencer](https://github.com/edspencer)! - Chat list: merge the streaming dot into a spinning context ring and reflow rows.

  The separate pulsing "response in-flight" dot is gone — the context ring now
  doubles as the activity indicator: it spins while a chat is streaming (keeping
  its context-fill arc, or showing an indeterminate spinner arc for a brand-new
  chat with no usage yet) and reverts to the static gauge when idle. Each row is
  reflowed so the title leads and the indicator floats to the far right of row 1,
  while the four hover actions (fork / rename / archive / delete) drop to the
  second row alongside the relative time instead of overlaying the title.

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

- [#97](https://github.com/edspencer/paddock/pull/97) [`dc9b4ab`](https://github.com/edspencer/paddock/commit/dc9b4abfe8253b65c939b76602eda1cdc4b75f8d) Thanks [@edspencer](https://github.com/edspencer)! - feat: search the chat list from a compact search field (#96)

  Replaces the full-width **New Chat** button above the chat sidebar with a
  **search input + a compact square `+` button** (plus icon only). Typing filters
  the chat list live — a case-insensitive substring match over each chat's name
  and its first-message preview — with the count badge showing `matches/total`
  while filtering. A clear (`×`) button and a "No chats match" empty state round
  it out; the `+` button behaves exactly as New Chat did before. Filtering is
  fully client-side (the list is already in memory), so there is no server
  round-trip.

## 0.12.0

### Minor Changes

- [#93](https://github.com/edspencer/paddock/pull/93) [`a177845`](https://github.com/edspencer/paddock/commit/a177845e9af8e3537b5424f810ca868079bebb5e) Thanks [@edspencer](https://github.com/edspencer)! - feat: queue a message to auto-send when the current turn finishes (#91)

  While the agent is streaming a turn, the composer no longer no-ops on
  Enter/Send — it **queues** a single follow-up message that fires automatically
  the moment the turn completes. A slim toolbar directly above the composer shows
  the queued message (first line) with a "queued" indicator; hovering reveals
  **Edit** (pops it back into the composer, cancelling the pending auto-send) and
  **Clear** (discards it). Mirrors Claude Code's model: exactly one queued message,
  and re-submitting while one is queued **appends** to it rather than stacking a
  second.

  When the queued message spans more than its first line, the toolbar appends a
  muted **"+N characters"** hint so it's clear the message continues beyond what's
  shown.

  Semantics: the queue is held (not fired) if the in-flight turn errors or is
  **Stop**ped, so a follow-up never lands in a cancelled/errored turn. A queued
  slash command flushes through the command path. The composer placeholder and the
  Enter hint switch to "queue" wording while a turn is streaming.

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

## 0.10.0

### Minor Changes

- [#87](https://github.com/edspencer/paddock/pull/87) [`0dfd9ec`](https://github.com/edspencer/paddock/commit/0dfd9ec46c061843aabeed2f726523eaca631673) Thanks [@edspencer](https://github.com/edspencer)! - Slim the project chrome on mobile so the chat gets far more vertical space. The
  project header collapses to a compact single-row breadcrumb (the project name
  links up to the Home tab; the tags, "Overview" badge, "updated" time and summary
  are desktop-only now, since they live on Home), and a small "+" starts a new
  chat. On the mobile **chat** view the tab bar is hidden entirely — the chat is a
  focused view, and the tabs (Home · Chat · Files · Changes) live on the Home hub,
  reachable by tapping the project name. At 390×844 this reclaims ~90px: the
  header drops 105px→53px and the tab bar (~41px) is gone. Desktop is unchanged
  (full header + tab bar).

## 0.9.0

### Minor Changes

- [#73](https://github.com/edspencer/paddock/pull/73) [`4d3aeb0`](https://github.com/edspencer/paddock/commit/4d3aeb022b865e2fefe507fba5ad09faed4e8ccf) Thanks [@edspencer](https://github.com/edspencer)! - Add a project **Home** tab — a real landing/overview for each project. Opening a
  project (the bare `/projects/:slug`) now defaults to `/home` instead of silently
  forwarding into a chat. The Home tab gathers the project summary + metadata
  (with an "Edit details" shortcut), recent chats, a preview of the files, and the
  CHANGELOG — everything deep-linkable via `/projects/:slug/home` and restorable
  via the sticky last-tab. Tabs are now **Home · Chat · Files · Changes**; the
  former "Files & Changelog" tab is just **Files** (summary + changelog moved to
  Home). This also gives the mobile UI a proper navigation hub.

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

- [#79](https://github.com/edspencer/paddock/pull/79) [`b587822`](https://github.com/edspencer/paddock/commit/b58782263d9b4de27470637a3211d74eef637b9d) Thanks [@edspencer](https://github.com/edspencer)! - chore(web): code-split the bundle (#11)

  The markdown renderer (react-markdown + remark-gfm) and the four top-level route
  components are now loaded as separate async chunks instead of sitting in the
  entry bundle:

  - `Markdown` lazy-loads its renderer (`MarkdownRenderer`) via `React.lazy`, with
    a plaintext fallback so streaming chat never flashes empty while the chunk
    fetches. `mermaid` was already dynamically imported.
  - The router (`main.tsx`) lazy-loads `ProjectsGrid`, `ProjectView`,
    `ProjectRedirect`, and `OneOffChat`; `AppShell` wraps `<Outlet>` in a Suspense
    boundary with an unobtrusive spinner.

  Result: the entry chunk drops from ~474 kB / 144 kB gzip to ~230 kB / 74 kB gzip
  (−48% gzip). react-markdown and each route now load on demand.

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

- [#71](https://github.com/edspencer/paddock/pull/71) [`30e24eb`](https://github.com/edspencer/paddock/commit/30e24eb5873bbb63f92bce36e8b81f072fc5b200) Thanks [@edspencer](https://github.com/edspencer)! - Lock document scroll on mobile so the app chrome no longer drags with the page.
  The UI is a fixed-height shell whose panes scroll internally, but the document
  itself was still scrollable — so on mobile Safari a swipe that started on the
  "fixed" top bar or composer rubber-band-scrolled the whole page. Lock
  `overflow` + `overscroll-behavior` on html/body (and keep momentum inside the
  transcript with `overscroll-contain`); only the inner panes scroll now.

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

### Patch Changes

- [#67](https://github.com/edspencer/paddock/pull/67) [`46d5d5d`](https://github.com/edspencer/paddock/commit/46d5d5d9a15479fb9031dee0b9b12debb4aab1a5) Thanks [@edspencer](https://github.com/edspencer)! - Show the Paddock version in the sidebar. The bottom-left tagline ("Project-first Claude Code, hosted.") is replaced with the running version (e.g. `v0.4.1`), injected at build time from the package version via a Vite `__APP_VERSION__` define.

## 0.4.1

### Patch Changes

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

## 0.2.0

## 0.1.0

### Minor Changes

- [#43](https://github.com/edspencer/paddock/pull/43) [`c72edad`](https://github.com/edspencer/paddock/commit/c72edadce629f15f31bb72d0c4c4c9f46220cb6b) Thanks [@edspencer](https://github.com/edspencer)! - Establish an app-mode release pipeline: changesets-driven versioning + changelog, a multi-arch Docker image published to `ghcr.io/edspencer/paddock`, and a self-contained release tarball attached to each GitHub Release. Packages are not published to npm.
