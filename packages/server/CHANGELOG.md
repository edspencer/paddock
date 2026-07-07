# @paddock/server

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
