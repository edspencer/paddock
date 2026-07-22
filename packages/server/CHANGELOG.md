# @paddock/server

## 0.42.2

### Patch Changes

- [#400](https://github.com/edspencer/paddock/pull/400) [`9f12b01`](https://github.com/edspencer/paddock/commit/9f12b011c910bd05117b826963a5b591f3af36bc) Thanks [@edspencer](https://github.com/edspencer)! - Fix live context meter inflating after tool-heavy turns (#398)

  The live composer context meter (and chat-list ring) could jump far above the
  true context — e.g. **828k/1M (83%)** live when the real window was ~292k
  (~28%) — right after a long, multi-step turn. A refresh fixed it (the disk path
  was already correct).

  Root cause: the `ws.ts` turn loop ran `extractUsage` on every SDK message and
  kept the block with the MAX `contextTokens` (`pickTurnUsage`, #165). It also read
  top-level usage, so it ingested the terminal `type:"result"` message — whose
  `usage` (`SDKResultSuccess.usage`) is the **cumulative** total aggregated across
  every internal API call in the turn (`num_turns`), not a single context-window
  snapshot. On a many-round turn that cumulative block dwarfs any single assistant
  block, so it won the max and inflated `chat:complete.meta.usage.contextTokens`.
  The result message is control-plane and never persisted to `.jsonl`, so the disk
  endpoints only ever saw assistant blocks and stayed correct — hence a refresh
  fixed it. (`pickTurnUsage`'s #165 comment assumed the result block carried zeroed
  cache fields; the current SDK populates them cumulatively.)

  Fix: `extractUsage` now flags the `type:"result"` message (`fromResult`), and the
  turn loop (`foldTurnUsage`) routes its cumulative usage to a **separate** field
  that never touches the context snapshot. The context meter derives from the
  assistant snapshot only — the last assistant block's `input + cache_read +
cache_creation`, which grows monotonically through the turn ("last" == "max") and
  matches the disk path exactly, so there is no overshoot and no refresh needed. The
  #165 behaviour is preserved (a cache-less/zeroed block never lowers the snapshot,
  and a result-only turn still falls back to the result). The result's cumulative
  `outputTokens` is still surfaced (for the cost readout), just never as
  `contextTokens`.

- [#399](https://github.com/edspencer/paddock/pull/399) [`59ffe9d`](https://github.com/edspencer/paddock/commit/59ffe9d72f1335616c8ebe71b44114758c3cc49e) Thanks [@edspencer](https://github.com/edspencer)! - Fix keeper auto-recovery firing a competing resume that self-interrupts (issue
  #397). Layer-3 auto re-drive (#301/#352) detected a killed-at-turn-boundary hang
  and injected the recovery nudge while herdctl's `SessionReaper` was still keeping
  the original `claude` subprocess alive (keepAlive + its ~15s re-invocation grace).
  Because Paddock drives every session-mode turn as a fresh `openChatSession(resume)`
  = a NEW subprocess, the re-drive spawned a second `claude` on the same session id;
  the SDK resolved the collision by interrupting the in-flight turn (`[Request
interrupted by user]`), so the auto-recovery turn produced nothing and the user was
  still stuck. The #352 stand-down guard only checked `hub.isRunning`, which is blind
  to a reaper-kept-alive subprocess.

  The recovery engine now consults the reaper's true liveness
  (`getSessionLifecycle()?.reaper.isSessionLive`, null-safe) alongside `hub.isRunning`,
  and — rather than standing down permanently (which left recovery incomplete, since
  the reaper reaps silently and nothing re-arms) — DEFERS: it re-checks on a settle
  poll and fires the nudge exactly once the session is genuinely idle, bounded by a
  settle window so a session that never releases can't retry forever. Pairs with the
  herdctl-side class-fix (herdctl#403: `openChatSession` should guard on
  `isSessionLive` before spawning a second subprocess).

- [#393](https://github.com/edspencer/paddock/pull/393) [`88b3c91`](https://github.com/edspencer/paddock/commit/88b3c9168029c793da2377d57316aa19e9f35dce) Thanks [@edspencer](https://github.com/edspencer)! - Render an in-flight tool block on history rehydration (herdctl#399)

  `@herdctl/core@5.24.0` now emits a still-running foreground `tool_use` as a
  `ChatToolCall.pending: true` message when a transcript is rehydrated (empty
  output, no duration), upgraded in place when its `tool_result` arrives. This
  wires that flag through the web so a page refresh mid-turn shows the same live
  "RUNNING" affordance (#175) — a spinner + "Running…" body — instead of the tool
  block vanishing or looking completed. A pending `Agent`/Task shows the running
  SUB-AGENT box and is not treated as expandable.

  - **web** — type `ChatToolCall.pending` end-to-end; the shared `ToolBlock`
    already rendered the pending state from the live path, so the reload path now
    reuses it unchanged.
  - **server** — the two paired-only positional enrichment joins
    (`attachSubagentFields`, `attachToolDetails`) now skip the injected unpaired
    pending message so it can't consume a completed sibling's recovered
    fields/detail and misalign it (e.g. a still-running parallel sub-agent wrongly
    inheriting a finished sibling's `hasSubagent` and rendering as expandable).

- [#395](https://github.com/edspencer/paddock/pull/395) [`0655f33`](https://github.com/edspencer/paddock/commit/0655f33f0a71cabd11d973f36830d204673f981e) Thanks [@edspencer](https://github.com/edspencer)! - Fix the false "The keeper turn failed before producing a reply." banner that still
  appeared beneath complete, successful replies on tool-heavy turns (residual of
  #380/#382; issue #394). The live-path reply predicate
  (`messageProducedReply`/`suppressNoticeAfterReply`) required a single assistant
  message with text **and** `stop_reason:"end_turn"`, but long tool-driven turns carry
  their prose on a message that also makes a tool call (`stop_reason:"tool_use"`) and
  end on a thinking-only `end_turn` message (zero text), so `producedReply` never
  flipped and the benign terminal `error_*`/`success:false` result surfaced a banner
  that only cleared on refresh. The predicate now treats **any** non-synthetic
  assistant text as reply-producing (regardless of `stop_reason`), accumulated across
  the whole turn on both the interactive and wake emit paths — matching the history
  path exactly. A genuinely empty turn (no assistant text anywhere) still surfaces the
  error.

## 0.42.1

### Patch Changes

- [#391](https://github.com/edspencer/paddock/pull/391) [`45cb892`](https://github.com/edspencer/paddock/commit/45cb8923cb0aed4b9ea8ab2ccc2efe813dfb8d16) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to `^5.24.0`, bringing two upstream fixes: in-flight (unpaired) `tool_use` blocks are now surfaced when rehydrating a transcript (`ChatToolCall.pending`), so a running foreground `Agent`/Task sub-agent no longer vanishes from the reconstructed history on refresh (herdctl#399); and `getAgentSessions` is now worktree-aware, so a keeper session that enters a native git worktree stays discoverable/attributed instead of dropping out of the sidebar (herdctl#401).

## 0.42.0

### Minor Changes

- [#386](https://github.com/edspencer/paddock/pull/386) [`70bb8c8`](https://github.com/edspencer/paddock/commit/70bb8c86fb3ccaa9d4d15df8e96a25678c3a2636) Thanks [@edspencer](https://github.com/edspencer)! - Add an instance-wide Settings screen that edits `paddock.config.yaml` (#385)

  A new top-level admin Settings screen (`/settings`, reachable from a gear in the
  sidebar) reads the instance configuration and writes the editable subset back to
  `paddock.config.yaml` — no more hand-editing the file + restarting for the ~25
  instance knobs (curation budgets, capabilities, recovery, attachments, branding,
  transcription, git identity, log level, …).

  - `GET /api/instance-config` reports every surfaced field with its
    `value`/`default`/`editable`/`sensitive`/`envOverridden` flags; no secret
    values are ever included.
  - `PUT /api/instance-config` validates a patch against an editable allowlist and
    writes the file **comment-preservingly** (the `yaml` `Document` API) and
    **atomically** (temp + rename), creating it on first write.
  - Instance config is read once at boot and frozen, so writes are
    **restart-required** — the screen shows a persistent banner saying so.
  - Fields shadowed by a `PADDOCK_*` env var (env > file > default) render
    read-only with an "overridden by environment variable" note; process/filesystem
    bindings (ports, paths) and auth are read-only display in v1.

- [#387](https://github.com/edspencer/paddock/pull/387) [`66d3ac8`](https://github.com/edspencer/paddock/commit/66d3ac8cbe1c5cfdfc80226552184bf702defc2a) Thanks [@edspencer](https://github.com/edspencer)! - Per-project curation budget overrides (#384). The sweeper's three token budgets (OVERVIEW / CHANGELOG / CLAUDE.md) can now be set per-project — in `project.yaml` (`curation:`) and in the project Settings tab — overriding the instance defaults from #383 field-by-field. Mirrors the existing `recovery`/`attachments` per-project-override pattern: a new `curation-config.ts` resolver, sanitisation on read/write, resolution at sweep time, and inherit/override/clear UI showing the instance default (exposed via `GET /api/models` as `curationDefault`).

## 0.41.0

### Minor Changes

- [#377](https://github.com/edspencer/paddock/pull/377) [`bcda46a`](https://github.com/edspencer/paddock/commit/bcda46adf18c3fd64e623b22ab74016b54e3ba57) Thanks [@edspencer](https://github.com/edspencer)! - Draggable, persisted widths for the side-nav and chat-list panes on desktop
  (#374). Each pane has a drag handle on its right edge; the chosen width is
  clamped to sane bounds, persisted per-browser in localStorage (so a laptop and a
  desktop can differ), reset on double-click, and keyboard-resizable (Arrow keys)
  for accessibility. Desktop-only — gated on `(min-width: 1024px)` so the mobile
  off-canvas drawer layout is unchanged.

- [#376](https://github.com/edspencer/paddock/pull/376) [`219c565`](https://github.com/edspencer/paddock/commit/219c565766f6747e7ddac0c2a68afdc11e0a30f2) Thanks [@edspencer](https://github.com/edspencer)! - Star (pin) chats to the top of the list (#373). A new per-chat star flag,
  orthogonal to archiving, floats starred chats to the top of both the active list
  and the Archived section (order preserved within each group). Backed by a
  `StarStore` sidecar mirroring `ArchiveStore`, with `POST /api/projects/:slug/chats/:sessionId/star`
  (and a scratch equivalent) and a rightmost, gold star action on each chat row.

- [#383](https://github.com/edspencer/paddock/pull/383) [`b9894d5`](https://github.com/edspencer/paddock/commit/b9894d5b739deb33880f7c3c9f98cb2ab6ec7bd7) Thanks [@edspencer](https://github.com/edspencer)! - Retire the sweeper's tool-less structured-text truncation; make it a proper file-maintaining curator (#379). The post-turn sweeper is now shown each curated file (OVERVIEW.md / CHANGELOG.md / CLAUDE.md) IN FULL and returns either the complete new file or NOCHANGE, instead of seeing only the first 2000 chars and blind-appending. This stops CHANGELOG.md and the CLAUDE.md curated notes (and the per-chat context they feed) growing without bound. Adds configurable per-file token budgets (`PADDOCK_CURATION_{OVERVIEW,CHANGELOG,CLAUDEMD}_MAX_TOKENS`, tri-state env < YAML < default) enforced as a backstop, a CHANGELOG change-detection gate (no near-duplicate "one bullet per sweep" entries), and a concurrency fix so activity in a 4th+ chat active within a debounce window is no longer dropped from curation.

### Patch Changes

- [#382](https://github.com/edspencer/paddock/pull/382) [`613d7e8`](https://github.com/edspencer/paddock/commit/613d7e88176b70d39fb0e77d7f2e4fe9a494d097) Thanks [@edspencer](https://github.com/edspencer)! - Fix the false "The keeper turn failed" banner rendered beneath a completed reply
  (#380). A session-mode turn can stream a normal `end_turn` reply and then have
  the SDK's terminal `result` frame arrive with an error subtype (or
  `success: false`) — a transient failure the runtime recovered a reply around.
  The live path (`ws.ts`) surfaced that dead-end in real time, so a red banner
  appeared under a perfectly good answer; a reload cleared it, because the
  history-hydration path (`scanTranscriptNotice`) already suppresses a dead-end
  once a real assistant reply is the last thing on the transcript.

  The live path now applies that same guard: it tracks whether a complete reply
  was produced this turn (`messageProducedReply` — a non-synthetic assistant
  message with `end_turn` + non-empty text) and suppresses the `error`/`max_turns`
  notice when one was, in all three drive loops (human `onChatSend`, spawned
  `startAgentTurn`, and the wake loop). `usage_limit` notices are unaffected — a
  session-limit stop is a real dead-end worth showing even beside text — and the
  `chat:complete` `success` flag is left unchanged; only the user-facing notice is
  suppressed. Sibling of #329/#363 (which fixed `is_error:true` on a
  `subtype:"success"` result); this is the case where the subtype itself is an
  error after a reply already streamed.

## 0.40.0

### Minor Changes

- [#370](https://github.com/edspencer/paddock/pull/370) [`5337925`](https://github.com/edspencer/paddock/commit/5337925c6dc55cff7b62d463f4f1cfc4f1104b40) Thanks [@edspencer](https://github.com/edspencer)! - Promote a **notebook** project into a **repo-backed** one _in place_ (#213),
  preserving its chats and sidecar metadata. Repo-backing was previously set only at
  creation (`repo` immutable, #187/#194); this relaxes that on one path so a
  history-rich notebook can attach an external git repo without a teardown/recreate.

  `ProjectStore.promote(slug, repo)` clones the repo into the nested `.gitignore`d
  checkout (clone-first with rollback — a clone failure leaves the notebook wholly
  intact), sets `repo:` in `project.yaml` (flipping the keeper's cwd to the checkout so
  the repo's own `CLAUDE.md`/git/PR flow apply), writes the sidecar `.gitignore`
  (`/<repo-name>/` + `/.chats/`), and removes the notebook's sweeper-owned `CLAUDE.md`
  (the repo's own takes over). Existing chats need no transcript surgery: they already
  live in `.chats/`, and re-registering the keeper re-symlinks the new cwd's encoded
  transcript path at that same store, so every chat stays listed and resumable.

  Surfaced as `POST /api/projects/:slug/promote` and a two-step-confirm "Repository
  backing" section in the project Settings tab (a repo-backed project shows its backing
  read-only — promotion is one-way).

### Patch Changes

- [#371](https://github.com/edspencer/paddock/pull/371) [`29b92f0`](https://github.com/edspencer/paddock/commit/29b92f0b50beec6edefb041f26448891da0102a3) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to `^5.23.0` and `@herdctl/chat` to `^0.8.0`. This herdctl
  release carries inline-image support (herdctl #385/#386 — image content blocks are
  preserved through extraction and translation) and token-accounting fixes
  (herdctl #378). `@herdctl/core` is deduped to a single installed version (5.23.0),
  which is also what `@herdctl/chat@0.8.0` resolves — no split/duplicated core.

- [#366](https://github.com/edspencer/paddock/pull/366) [`41f6740`](https://github.com/edspencer/paddock/commit/41f6740516c51f9eac60e4ef4b04af23c0dbbd11) Thanks [@edspencer](https://github.com/edspencer)! - Narrow the keeper's over-broad `rm -rf` deny rule (#179). The default
  `denied_tools` list carried `Bash(rm -rf /*)`, whose trailing `*` made it a
  prefix match on `rm -rf /` — so it denied **every** absolute-path delete,
  including the keeper cleaning up its own scratch/clone dirs
  (`rm -rf /tmp/foo`, `rm -rf /var/lib/.../clones/x`), while giving false
  security (a relative `rm -rf clones/x` sailed straight through). The rule is
  replaced with a narrow, honest set of catastrophic root/home/system-dir
  patterns (`rm -rf /`, `rm -rf / <args>`, `rm -rf ~`/`$HOME`, and bare top-level
  system dirs matched exactly) that leaves legitimate absolute-path cleanup under
  project/tmp roots untouched. `sudo *` and `chmod 777 *` are unchanged. This
  denylist is best-effort defence-in-depth, not a sandbox — real per-agent
  filesystem isolation is tracked separately (#7).

- [#367](https://github.com/edspencer/paddock/pull/367) [`c750e03`](https://github.com/edspencer/paddock/commit/c750e03b35364649d779227217d0a94974e34072) Thanks [@edspencer](https://github.com/edspencer)! - Fix RunProvenance mislabelling a human chat as "scheduled" (#353). A session
  wake is a _resume_, not a _creation_: `onSessionWake` fires when a
  `ScheduleWakeup`/`/loop` resumes an already-existing chat, and it never creates
  one. It was stamping `stampIfAbsent(SCHEDULED_ROOT)`, which was correct only for
  chats that already carried a creation stamp — but a chat that predates
  provenance stamping (empty slot) and later arms a `ScheduleWakeup` would get
  falsely labelled `scheduled` on its first wake, badging a human-rooted chat as a
  cron root.

  The wake path no longer stamps a creation origin at all. Genuinely
  schedule-_created_ chats are already stamped `scheduled` at creation
  (`fireTriggerForProject` → `startAgentTurn`), so nothing is lost for them;
  legacy/blank chats now stay unbadged (the correct outcome for a human chat)
  instead of mislabelled.

## 0.39.1

### Patch Changes

- [#363](https://github.com/edspencer/paddock/pull/363) [`b69c0e0`](https://github.com/edspencer/paddock/commit/b69c0e0a4f2a2c4ceeb5bd1b5ff5c84c8d2e6b61) Thanks [@edspencer](https://github.com/edspencer)! - fix(#329): stop rendering a false "The turn failed" banner beneath a perfectly good reply

  The turn-notice classifier (#361/#329) treated a terminal `result` message with
  `is_error: true` as a turn failure. But `SDKResultSuccess` is typed
  `is_error: boolean`, and the runtime stamps `is_error: true` on a
  `subtype: "success"` result when a session-mode turn RECOVERS from a transient
  mid-turn API error (e.g. "Connection closed mid-response") and still produces a
  normal reply. That fired a red error banner + Retry beneath essentially every
  successful session-mode turn.

  `classifyResult` now keys off the authoritative signal — an `error_*` `subtype`
  (or an explicit `success === false`) — exactly matching `@herdctl/core`'s own
  success computation, so Paddock never disagrees with herdctl about whether a
  turn failed. A bare `is_error: true` with no subtype is still treated as an error
  (defensive). Genuine usage-limit, max-turns, and API/error results are unchanged.

## 0.39.0

### Minor Changes

- [#357](https://github.com/edspencer/paddock/pull/357) [`9ce95af`](https://github.com/edspencer/paddock/commit/9ce95af7a0a0e2174a85ceb41732facd27bcd7f6) Thanks [@edspencer](https://github.com/edspencer)! - Restore "Run now" + live run-status to the Triggers tab (#327). When Epic T folded the Settings→Schedules section into the unified Triggers tab, two capabilities were lost because `TriggerDto` carries trigger config only, not herdctl runtime state.

  - **Run now** — `POST /api/projects/:slug/triggers/:name/run` fires any trigger on demand through the existing `fireTrigger` hub path (a first-class, badged run, regardless of the `enabled` flag), surfaced as a per-row action in the Triggers tab and as a `run_trigger` self-MCP verb.
  - **Live status columns** — `GET /api/projects/:slug/triggers/runtime` joins herdctl job records (last-run, per the #268 run-history pattern) with the cron scheduler's `ScheduleInfo` (next-fire + status) into a per-trigger runtime DTO. The tab polls it to show each trigger's last-run / next-run / running-state.

### Patch Changes

- [#358](https://github.com/edspencer/paddock/pull/358) [`7eef0ed`](https://github.com/edspencer/paddock/commit/7eef0eda4a275fc835ed5b7d1173560dbda4bb08) Thanks [@edspencer](https://github.com/edspencer)! - Render client-local slash commands (`/context`, `/usage`, …) correctly (#158). These commands render their output to a `type:"system"` / `local_command` transcript entry (live: a `model:"<synthetic>"` assistant placeholder) that @herdctl/core's parser and @herdctl/chat's translator both drop — so the command turn used to show nothing useful, leaving only the raw `<command-name>` / `<local-command-*>` scaffolding as empty/user bubbles. Paddock now surfaces the recovered output as a clean, labeled "command output" block in BOTH the live path (ws.ts, mirroring the existing `compact_boundary` note) and on history reload (a new `localcommand.ts` recovery pass re-injects the dropped `<local-command-stdout>`), and the web drops the `<local-command-caveat>` framing note instead of rendering it. `/context` renders its full usage table; `/usage` shows session cost (its plan/rate-limit portion needs an OAuth token with `user:profile` scope, which the keeper token lacks). Paddock's own context ring + cost meter remain the primary usage view.

- [#355](https://github.com/edspencer/paddock/pull/355) [`3d4cbd0`](https://github.com/edspencer/paddock/commit/3d4cbd02e1f13a61a6df1057114885238f1de430) Thanks [@edspencer](https://github.com/edspencer)! - Complete keeper-chat Layer 3 auto re-drive (#301/#352). Now that #350 fixed
  detection (the turn-boundary task kill is recognised in its `queue-operation`
  shape), the automatic re-drive fires reliably. Two double-dispatch guards ensure
  the first injected nudge lands instead of being swallowed:

  - The recovery engine stands down if a live turn is already driving the session
    when it goes to act (a human message, a queued-message drain, or a prior
    nudge) — resuming an in-flight session-mode `chatSession(resume)` interrupts
    and swallows the live turn (the "first message swallowed" symptom). No surface,
    no re-drive, and no retry is consumed; a fresh watch arms when that turn ends.
  - `injectRecoveryNudge` (shared by the manual **Continue** button and the auto
    re-drive) is single-flight per session and yields to any in-flight turn, so two
    near-simultaneous dispatches can't both resume the same session.

  The config surface is unchanged: `autoReDrive` (default OFF) + `debounceMs` +
  `maxRetries` at instance level (`PADDOCK_RECOVERY_*`) with a per-project
  `recovery` override, exactly like `driveMode`/`maxSpawnDepth`.

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

- [#356](https://github.com/edspencer/paddock/pull/356) [`b49ca29`](https://github.com/edspencer/paddock/commit/b49ca2961b117fafa07b4bb4845bf6fb87f169a9) Thanks [@edspencer](https://github.com/edspencer)! - Let the self-MCP spawn tools pick the spawned chat's model (#336). `create_chat`, `fork_chat` and `fork_chat_batch` now take an optional `model` argument (validated against the same picker allow-list as the web model-picker: `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`). An orchestrating chat fanning out worker chats can now put each on a specific, cheaper/faster model (e.g. Sonnet for straightforward docs, Opus for hard implementation) without changing the project's default model for all its chats. The override applies to the spawned chat's kickoff turn only via the existing per-chat keeper re-registration (same last-write-wins caveat as the human picker); omitting `model` is unchanged (inherits the project/box default). An unknown model id is rejected with an actionable error. Composes with the existing spawn gating (`selfMcpWriteEnabled`, `maxSpawnDepth`).

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

### Patch Changes

- [#350](https://github.com/edspencer/paddock/pull/350) [`04f3950`](https://github.com/edspencer/paddock/commit/04f3950402a7fa2a6faf7d6dde99a9a055b210df) Thanks [@edspencer](https://github.com/edspencer)! - Fix keeper-chat recovery (#301/#347): a background task killed at the turn boundary was undetectable because its `<task-notification>` is delivered to the SDK's input queue as a `queue-operation` entry, not a `type:"user"` transcript entry — the shape the recovery watch classified. The engine now recognises the queue-operation form (the only one present inside the watch window), so auto re-drive fires when enabled. The watch is also armed under `surfaceKilledTask` (default on) and, on detection, broadcasts a live `chat:killed_task` frame so the "keeper is idle / Continue" affordance appears without a manual refresh.

## 0.38.2

## 0.38.1

### Patch Changes

- [#343](https://github.com/edspencer/paddock/pull/343) [`3b30cd6`](https://github.com/edspencer/paddock/commit/3b30cd6f4f7d88ec2ac30c980dd0619347f06bdc) Thanks [@edspencer](https://github.com/edspencer)! - Fix the injected-MCP "flap": re-establish self-management / send_file tools on session wakes (herdctl#390)

  In session drive-mode, Paddock injects its in-process MCP servers
  (`mcp__paddock_manage__*` self-management, `mcp__paddock__*` send_file) into keeper
  turns via `injectedMcpServers`. herdctl's session **wake** path — a
  `ScheduleWakeup` / `/loop` / `CronCreate` re-fire of an idle, reaped session — drove
  the turn inside herdctl and re-spawned the agent subprocess with those tools still
  "allowed" but with no in-process server behind them, so they vanished from the tool
  catalog for the whole autonomous stretch (observed multi-hour episodes; permanent
  after a server restart, since the durable wake set re-fired without injection).

  `@herdctl/core` 5.22.1 added `FleetManager.setResolveInjectedMcpServers(resolve)` — a
  synchronous resolver herdctl calls on each wake fire and threads into
  `openChatSession` before the subprocess spawns. This change registers Paddock's
  policy for it:

  - Bump `@herdctl/core` to `^5.22.1`.
  - Extract the per-turn injection construction into a shared `buildInjectedMcpServers`
    builder (`wake-injection.ts`), used by both the live `startAgentTurn` path (no
    behaviour change) and the wake rebuild, so the two can never drift.
  - Cache the exact server set built for each live turn (human socket path and
    `startAgentTurn`); the sync resolver replays it on a wake. This closes the flap for
    the common case — a chat that self-schedules a wake is warm when it fires. On a cold
    miss (a durable wake re-firing after a **server restart**, before any live turn
    re-populates the cache) the resolver kicks a background rebuild so the **next** wake
    is covered; the first post-restart wake still degrades to no-injection until the next
    human/Trigger turn — the single documented residual.

  Depth/scratch/self-MCP gating semantics are unchanged. No `@herdctl/chat` bump needed
  (it accepts core `^5.22.0`).

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

- [#317](https://github.com/edspencer/paddock/pull/317) [`058dde8`](https://github.com/edspencer/paddock/commit/058dde810b25918bb3fd6900be6f4bf9d0f02801) Thanks [@edspencer](https://github.com/edspencer)! - Collapse the paired hook + schedule verbs onto the unified **triggers** surface
  (Epic T / T3), building on the T1 `TriggerService`:

  - **REST**: `GET/PUT/DELETE /api/projects/:slug/triggers[/:name]`. The list `GET`
    serves the capability-picker catalog (the `GRANTABLE_TOOLS` tool list, the known
    event values, and the trigger types). `PUT` is a full-replace create/update;
    enable/disable is just `set` with `enabled` flipped (no separate verb). All changes
    persist to `project.yaml`'s single `triggers` block and arm herdctl (an event
    trigger's own `trigger-<slug>-<name>` agent, a schedule trigger's forwarded
    `schedules` entry).
  - **Self-MCP**: the `set_hook`/`set_schedule` (+ `list_*`/`remove_*`) verbs are
    replaced by unified `set_trigger` / `list_triggers` / `remove_trigger`, carrying the
    discriminated `trigger` (`schedule | event | webhook`) + shared `run` + `enabled`.
    `set_trigger` is a partial patch (an `enabled`-only call just flips the toggle;
    supplying `prompt` clears an inherited `promptFile` and vice-versa). The tools are
    gated by the reused per-project trigger-MCP opt-in (absent when off).

  The legacy `hooks:`/`schedules:` REST + config blocks remain additively until the
  Triggers tab (T4) migrates the UI off them.

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

- [#323](https://github.com/edspencer/paddock/pull/323) [`a3f63a1`](https://github.com/edspencer/paddock/commit/a3f63a149ed5aaffd962cda560509c8ef312501a) Thanks [@edspencer](https://github.com/edspencer)! - Fold the sweeper in as the default `afterTurn` trigger (Epic T / T5, #310). The
  post-turn overview/changelog curator (the tool-less sweeper) is now the default
  `curate-overview` `event`/`afterTurn` trigger. Every post-turn commit site (a human
  chat turn, a session-mode wake, and each server-initiated agent turn) emits ONE
  `afterTurn` lifecycle event, and its sole consumer enqueues the curation sweep — so the
  sweeper dispatches exactly once per turn (no double-curation). The default is
  **implicit**: a project that declares no `curate-overview` trigger sweeps exactly as
  before. Declaring one only customizes the default — extend the curation prompt via
  `run.prompt` / `run.promptFile` (folded under the same `=== EXTRA PROJECT-SPECIFIC
CURATOR INSTRUCTIONS ===` heading as the existing `.paddock/hooks/sweep.md`), override
  the sweeper model via `run.model`, or switch curation off with `enabled: false`. The
  curator is executed by `SweepService` via the `sweeper-<slug>` agent (returns marked
  text, Paddock writes OVERVIEW.md/CHANGELOG.md), so — unlike every other event trigger —
  it registers no scoped `trigger-<slug>-<name>` agent and is not fanned out to the
  generic event dispatcher.

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

- [#303](https://github.com/edspencer/paddock/pull/303) [`89bf364`](https://github.com/edspencer/paddock/commit/89bf364da07982a86eb5c55b04961573093a10dd) Thanks [@edspencer](https://github.com/edspencer)! - Keeper-chat recovery — Layer 3 automatic re-drive (#301)

  Builds on the Phase 0 config + Layer 2 manual Continue: a keeper whose background
  task is killed at the turn boundary (edspencer/herdctl#374) now recovers **without a
  human**, when `autoReDrive` is enabled (still default OFF).

  A new post-turn detection engine (`packages/server/src/recovery.ts`) tails a
  session-mode keeper's transcript after each turn. The hung signature — a terminated
  (`killed`/`stopped`) `<task-notification>` with no keeper reply after it — triggers
  the same recovery nudge the manual **Continue** button injects
  (`startAgentTurn` + `RECOVERY_NUDGE` + `recovery` sender), so the keeper wakes on its
  own and carries on.

  Guards prevent misfires and loops: it only fires when the resolved `autoReDrive` is
  on (per-project override else instance default); a `debounceMs` quiet window means a
  keeper that wakes itself is never poked; a per-session `maxRetries` cap stops a
  permanently-wedged keeper from being poked forever; and a human message resets the
  session's guard so a genuinely-new later hang recovers fresh.

  Enable instance-wide with `PADDOCK_RECOVERY_AUTODRIVE=1`, or per project via the
  `recovery.autoReDrive` override in `project.yaml`. The `limboTimeoutMs` backstop timer
  remains a follow-up.

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

- [#300](https://github.com/edspencer/paddock/pull/300) [`c737f8a`](https://github.com/edspencer/paddock/commit/c737f8a018fdf39b9b72cf1ca977c2703f65dd25) Thanks [@edspencer](https://github.com/edspencer)! - Hook-management MCP: `list_hooks` / `set_hook` / `remove_hook` self-MCP tools (Epic G / G5).

  A project agent can now declare, edit, and delete its own event hooks through the
  `mcp__paddock_manage__*` self-management server — the MCP twin of the (future) Hooks
  tab. The three tools consume the G1 `HookService` (persist to `project.yaml`, then
  register the `hook-<slug>-<name>` agent), mirroring the shipped schedule-management
  tools. `set_hook` is create-or-update — `enabled` is just a field on the record (there
  are no separate enable/disable verbs), and a brand-new hook defaults to `enabled: false`
  (GG-3) so nothing fires the instant it is written; editing an existing hook without
  `enabled` leaves its armed state unchanged. Capabilities (`allowed_tools`,
  `denied_tools`, `permission_mode`, `model`, `max_turns`) are passed as flat args and
  tolerate the CLI-runtime MCP transport dropping array types (accepted as a JSON array
  or a comma/newline-separated string).

  The tools are gated by a **per-project `hooksMcpEnabled` opt-in** (a sibling of
  `selfMcpWriteEnabled`), **off by default**: an instance default (`PADDOCK_HOOKS_MCP`,
  also settable via the YAML instance config) with a per-project `project.yaml` override,
  resolved the same way as `maxSpawnDepth`. The gate is **binary access to the MCP** — an
  agent that has the tools can create hooks at any capability (GG-4: no per-capability
  gating, no curator/kind split). When the gate is off the tools are **absent** from the
  injected server, not present-but-refusing.

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

- [#295](https://github.com/edspencer/paddock/pull/295) [`2cc1c1b`](https://github.com/edspencer/paddock/commit/2cc1c1b08e6a15045eab347aff005d89dd70ec66) Thanks [@edspencer](https://github.com/edspencer)! - Sweeper-prompt extension: optional per-project `.paddock/hooks/sweep.md` (G2).

  A project can now commit extra curator instructions that are appended to the
  sweeper's prompt at sweep time, letting each project steer how its `OVERVIEW.md`
  / `CHANGELOG.md` are curated (e.g. "always keep a Glossary section", "note API
  changes prominently"). The file is git-tracked and keeper-editable, and lives
  alongside `project.yaml`/`OVERVIEW.md`/`CHANGELOG.md` in the project directory —
  the same directory the sweeper runs in.

  When the file is present and non-blank, its content is appended verbatim under an
  `=== EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS ===` heading (which refines _how_
  to curate but never overrides the output-marker format or the box-conventions
  rule); when it is absent or whitespace-only, sweep behaviour is exactly unchanged.
  Reads are non-fatal — a missing or unreadable file simply yields no extra
  instructions, so curation is never broken by a bad file.

  This is a sweeper-local convenience: it only shapes the tool-less curator's prompt
  and grants no new capability. It is deliberately not routed through the generic
  hook framework (there is no hook "kind" or "curator" concept).

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

- [#291](https://github.com/edspencer/paddock/pull/291) [`98f61d2`](https://github.com/edspencer/paddock/commit/98f61d25c7baf6d0c6be72198a6797c3535ed648) Thanks [@edspencer](https://github.com/edspencer)! - Self-MCP schedule management tools: `set_schedule` / `remove_schedule` / `list_schedules` (#289).

  A keeper can now define and manage its project's durable schedules programmatically
  via the self-management MCP — not just a human through the Settings UI. This is the
  natural next step for the manager-agent pattern ("schedule yourself to triage issues
  every morning"). Distinct from the ephemeral, session-scoped `ScheduleWakeup`: these
  tools persist the schedule in project config so it fires even when nobody is watching,
  with each fire appearing as a new chat carrying the `scheduled` badge.

  The three tools are exposed as **write** tools (present only when `selfMcpWriteEnabled`
  is on and the chat is within `maxSpawnDepth`), and simply surface the existing D3/D4
  server side — `ProjectStore.set/removeSchedule` (the `project.yaml` source of truth) +
  `HerdctlService.set/removeAgentSchedule` (live arming) — the exact two-step the REST
  routes use (persist first, then arm best-effort).

  - **`set_schedule`** — create or update a schedule by name, in herdctl's
    `ScheduleSchema` shape: `type` (`cron` with a 5-field `cron` expression, or
    `interval` with a duration like `30m`/`1h`), `prompt` (inline) or `prompt_file`
    (a `.md` under the project's `.paddock/schedules/` dir, read at fire time),
    `resume_session` (fresh chat each fire vs. accreting into one owned session), and
    `enabled`.
  - **`remove_schedule`** — delete a schedule by name (safe when absent).
  - **`list_schedules`** — read a project's schedules (declaration + live runtime
    state: status, last/next run, last error).

  `set_schedule` / `remove_schedule` honor DD-7's per-deployment schedule-mutation gate,
  refusing with a clear message when it's off; `list_schedules` is read-only and
  unaffected — mirroring the REST routes (PUT/DELETE gated, GET open).

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

- [#285](https://github.com/edspencer/paddock/pull/285) [`faceecd`](https://github.com/edspencer/paddock/commit/faceecd17e3087bfebe0eee139862cb7041d183b) Thanks [@edspencer](https://github.com/edspencer)! - Scheduled chat sessions, server side (#265).

  Ticket D3 of the Events / Schedules / Config initiative — the headline feature: a
  chat triggered by cron instead of by a human. A scheduled agent is just a normal
  Paddock chat that a schedule started, so a human can open it and continue the
  conversation afterward. Built on the A1 provenance marker (#261) and
  `@herdctl/core@5.21.0`'s new scheduling seam + runtime-mutation APIs (#375/#376).

  - **`project.yaml` `schedules`.** A project declares schedules in herdctl's own
    `ScheduleSchema` shape (`type: cron|interval`, `cron`, `interval`, `prompt`,
    `enabled`, `resume_session`), forwarded **unmolested** into the keeper agent's
    `schedules` block at `addAgent` time — herdctl's cron engine arms them directly,
    no parallel Paddock schema, no translation. Malformed entries are dropped (not
    thrown) so a bad hand-edit can't brick keeper registration.
  - **Trigger seam → the hub.** Paddock registers a `scheduleTriggerHandler` via
    `FleetManager.setScheduleTriggerHandler`, so a fired schedule runs on Paddock's
    OWN hub through `startAgentTurn` with **`origin: scheduled`** (depth 0). The run
    is a first-class chat: it streams live, drives the sidebar dot, is re-attachable,
    and is NEVER `isSidechain`-hidden (we bypass herdctl's headless `--resume`).
  - **`resume_session` new-vs-accrete.** `false` → a fresh chat each fire
    (`resume: null`); `true` → resume the schedule's ONE **owned session**, created
    on the first fire and reused thereafter — persisted in a `schedule →
ownedSessionId` sidecar (`ScheduleSessionStore`, the `ArchiveStore` /
    `RunProvenanceStore` pattern, including the in-flight-load-promise fix). A stale
    owned id whose transcript vanished is dropped so the next fire re-creates one.
  - **`promptFile` sugar.** A schedule may point at a git-tracked, keeper-editable
    `.paddock/schedules/*.md` file; Paddock reads it FRESH at fire time and forwards
    a plain `prompt` string, so an edit takes effect on the next fire with no
    re-register. The file indirection is stripped before forwarding — the herdctl
    config stays pure. Path traversal outside `.paddock/schedules/` and non-`.md`
    names are rejected.
  - **Runtime mutation plumbing.** `HerdctlService.setAgentSchedule` /
    `removeAgentSchedule` (for the future D4 UI) and `ProjectStore.setSchedule` /
    `removeSchedule` persistence, behind a per-deployment gate
    (`PADDOCK_SCHEDULE_MUTATION`, default OFF → the FleetManager is constructed with
    `allowScheduleMutation: false` and the mutation APIs throw). Declaring schedules
    statically in `project.yaml` is unaffected by the gate.

  Bumps `@herdctl/core` to `^5.21.0`.

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

- [#284](https://github.com/edspencer/paddock/pull/284) [`fa730f3`](https://github.com/edspencer/paddock/commit/fa730f3f2a549846c54424a0eb22f64bbed642fb) Thanks [@edspencer](https://github.com/edspencer)! - Config: YAML instance-config file loader, precedence file < env (#270).

  Ticket F2 of the Events / Schedules / Config initiative, building on F1 (#269).
  `PaddockConfig` is already a single serializable object; it can now be populated
  from an optional **YAML instance-config file** with **environment variables
  overriding** file values (precedence **file < env**). Existing `PADDOCK_*`
  deployments are unaffected — with no file present, resolution is byte-for-byte
  the env-only behaviour it was before.

  - **Location.** `PADDOCK_CONFIG` (an explicit path) if set, otherwise
    `<PADDOCK_DATA_DIR>/paddock.config.yaml`.
  - **Precedence.** Every file value is threaded in as the _fallback_ beneath the
    matching env read (via the existing `envOr`/`envOpt` helpers), so an env var
    always wins over the file, and the hardcoded default still applies when neither
    provides a value. Booleans/enums/paths keep their exact parsing and
    fall-back-to-default semantics. `PADDOCK_BROWSER_MCP` keeps its literal-`1`
    env semantics; the file layer uses the shared `1`/`true`/`yes` convention.
  - **No-op when absent.** A missing default file yields env-only behaviour. An
    explicit `PADDOCK_CONFIG` pointing at a _missing_ file, or a present-but-
    malformed file (unparseable YAML, or a top-level list/scalar instead of a
    mapping), fails startup with a **clear error** instead of a half-empty config.
  - **Empty sections are absent, not a crash.** A valueless key (`brand:` /
    `auth:` with nothing after it) parses to `null`; such an empty section (or
    scalar) is treated as absent and falls back to env/defaults rather than
    crashing a loader that expects an object.
  - Uses the same `yaml` library the repo already uses for `project.yaml`;
    `PaddockConfig` stays a plain serializable object. This is the container the
    schedule (and later hook) declarations will live in.

  Documented in `docs/CONFIGURATION.md`.

### Patch Changes

- [#282](https://github.com/edspencer/paddock/pull/282) [`c8695e9`](https://github.com/edspencer/paddock/commit/c8695e9854d290ec893c8cf594168967ce908e47) Thanks [@edspencer](https://github.com/edspencer)! - Self-MCP `create_chat`: honor the `name` param + clearer guidance (#264)

  The `create_chat` tool accepted a `name` argument but silently dropped it, so a
  manager fanning out children got chats titled by Claude's ~15-word auto-summary
  of the first turn instead of the concise title it asked for.

  - **Wire the `name` param.** After the chat is created, the callback applies the
    name via `renameSession` (mirroring how `fork_chat` names a fork), so the
    caller-supplied title wins over the auto-derived first-message name.
  - **Short-title guidance.** `CREATE_CHAT_DESC` and the `name` schema now instruct
    the caller to pass a concise **3–5 word** title.
  - **Preload description parity.** The `preload_context` wording now names both
    **OVERVIEW.md** and **CHANGELOG.md** (the behaviour already injected both —
    only the description was stale), matching the UI checkbox.
  - Deduped the two identical OVERVIEW+CHANGELOG preload blocks (human New-Chat
    path + `create_chat` spawn path) into one shared `composePreloadedPrompt`
    helper.

- [#283](https://github.com/edspencer/paddock/pull/283) [`b31c930`](https://github.com/edspencer/paddock/commit/b31c930176c3f7f969f54c6e573d5f7857557bcb) Thanks [@edspencer](https://github.com/edspencer)! - Config: fold scattered env reads into `PaddockConfig` (#269).

  Ticket F1 of the Events / Schedules / Config initiative — a pure refactor with no
  behaviour change, and the prerequisite for the YAML instance-config loader (F2).

  Previously ~7 environment knobs were read ad-hoc, scattered across modules, so no
  single object represented the whole instance. They are now resolved once (via the
  existing `envOr`/`envOpt` helpers) into `PaddockConfig` and threaded through where
  they're used:

  - `LOG_LEVEL` → `cfg.logLevel` (Fastify logger).
  - `PADDOCK_BROWSER_MCP` → `cfg.browserMcp` (`browserMcpServers(enabled)` in herdctl.ts).
  - `PADDOCK_SWEEP_MIN_INTERVAL_MS` → `cfg.sweepMinIntervalMs` (passed to `SweepService`).
  - `PADDOCK_GIT_AUTHOR_NAME` / `PADDOCK_GIT_AUTHOR_EMAIL` → `cfg.gitAuthor` (`GitService`).
  - `PADDOCK_GITHUB_CLIENT_ID` → `cfg.githubClientId` (`GithubAuth`).

  Defaults and parsing semantics are preserved exactly (e.g. an invalid sweep interval
  still falls back to the 5-minute default; a blank GitHub client id is still treated as
  "not configured"). `PaddockConfig` stays a plain, fully serializable object, which F2
  depends on.

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

- [#276](https://github.com/edspencer/paddock/pull/276) [`e299666`](https://github.com/edspencer/paddock/commit/e2996660be089f0f7a312ced50252a964b725c47) Thanks [@edspencer](https://github.com/edspencer)! - self-MCP: add `archive_chat` / `unarchive_chat` write tools (#263)

  The self-management MCP now lets a keeper archive (and unarchive) a chat — most usefully **itself**, which powers the self-reporting convention "do the work, then archive myself on success; leave un-archived on failure so it's flagged when a human logs in."

  - Two new write tools, gated by the same `PADDOCK_SELF_MCP_WRITE` flag as `create_chat`/`fork_chat`/`send_message`.
  - `session_id` is **optional** and defaults to the **current** chat (mirroring how `send_message` defaults `project`), so an agent can archive/unarchive itself without knowing its own id; `project` likewise defaults to the current one.
  - Wired through a new `SelfMcpWriteContext.setArchived` callback that delegates straight to the existing `ArchiveStore` (presentational metadata only — no keeper turn is started), keyed by the target project's keeper agent, matching the existing POST archive endpoints.

- [#275](https://github.com/edspencer/paddock/pull/275) [`d1c830a`](https://github.com/edspencer/paddock/commit/d1c830a9d3f9ef58615607b29bfc01b865d6e588) Thanks [@edspencer](https://github.com/edspencer)! - Thread an origin + spawn-depth provenance marker through non-human turn injection (#261).

  This is the foundation (ticket A1) for the Events / Schedules / Config initiative.
  Server-initiated turns — `startAgentTurn` (the self-MCP write tools' spawn path) and
  the `onSessionWake` handler — now carry an `origin` (`human` / `scheduled` / `spawned`)
  plus a spawn `depth`, and each chat's marker is persisted to a new per-chat sidecar
  (`run-provenance.json`, following the ArchiveStore / ReadStateStore pattern):

  - a human-started chat → `origin: human, depth: 0` (the root of any spawn tree);
  - a chat spawned by a self-MCP write tool (`create_chat` / `fork_chat` / …) →
    `origin: spawned, depth: parent.depth + 1`;
  - a scheduler-fired wake → `origin: scheduled, depth: 0` (stamped only if the chat
    has no marker yet, so a resume/wake never clobbers an existing chat's provenance).

  Provenance is recorded once, at chat creation, and is never overwritten by a later
  turn on that chat. This carries and persists the marker only — **no behaviour changes
  yet**: spawned children are still injected with `send_file` only (no self-MCP), exactly
  as before. Depth-gated spawn capability (#262) and provenance badges (#267) build on
  this marker.

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

### Patch Changes

- [#243](https://github.com/edspencer/paddock/pull/243) [`b042054`](https://github.com/edspencer/paddock/commit/b042054ee6ed09d5b1fcc8d3434f3cd1d0d6bcc1) Thanks [@edspencer](https://github.com/edspencer)! - Per-chat cost/token estimate now includes sub-agent spend (#242)

  The cumulative token totals and the ~$ estimate shown for a chat previously
  priced only the main transcript, ignoring every `Task`/`Agent` sub-agent (which
  run in their own sibling transcripts). Fan-out chats under-reported their true
  cost — sometimes by ~90%. `readSessionTokenUsageWithSubagents` now rolls each
  sub-agent transcript's per-model usage into the chat total (nested sub-agents
  included), so the headline dollar figure and token count reflect the whole chat.
  `contextTokens` (the last-turn context-window fill) stays main-only.

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
