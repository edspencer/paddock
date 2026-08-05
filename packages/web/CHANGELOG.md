# @paddock/web

## 0.62.0

## 0.61.1

## 0.61.0

### Patch Changes

- [#671](https://github.com/edspencer/paddock/pull/671) [`aa607e4`](https://github.com/edspencer/paddock/commit/aa607e47e061801f77298aa349d657b403577fe1) Thanks [@edspencer](https://github.com/edspencer)! - Remove the one-time #488 localStorage read-state backfill (#552)

  #488 made read-state server-authoritative and dropped the localStorage
  `lastSeen` mirror; to avoid resurfacing already-read chats it shipped a one-time
  migration that pushed any surviving `paddock:lastSeen:*` keys up to the server
  and deleted them. That migration has drained, but it was wired into the sidebar's
  projects effect — so it re-scanned every localStorage key on **every projects
  refresh, forever**, only to return early.

  `lastSeenBackfill.ts` and the two localStorage helpers it used
  (`legacyLastSeenEntries`, `clearLegacyLastSeen`) are gone. The client now has no
  localStorage read-state code path at all.

  The one caveat: a browser profile that has not opened Paddock since 2026-07-26
  still holds legacy keys that will now never be pushed up, so the chats they cover
  read as unread once. Those keys are inert — nothing reads them — and opening the
  affected chats clears the cue for good.

- [#672](https://github.com/edspencer/paddock/pull/672) [`62f518f`](https://github.com/edspencer/paddock/commit/62f518ff993055e74a8b3323a16a0bbbead41faa) Thanks [@edspencer](https://github.com/edspencer)! - An explicit "mark unread" now survives a turn landing in the focused chat (#608)

  Marking the open chat unread and having its in-flight turn complete a moment
  later silently discarded the flag. The web client marks the focused chat seen
  when a turn finishes there ("you were watching it"), and `POST .../seen` clears
  the manual unread override — so an inferred seen quietly overrode an explicit
  intent. The same happened via the API: `POST .../chats/:id/unread` returned
  `{ ok: true }` and the write was then undone by a browser sitting in that chat,
  with nothing telling the caller.

  `POST .../chats/:id/seen` now accepts `keepUnread: true`, which advances the
  last-seen watermark **without** clearing the manual override, and its response
  carries the override's resulting state (`{ ok, lastSeen, unread }`). The web
  client passes it only on the turn-completed-while-focused path; opening a chat
  and the explicit read/unread toggle still spend the flag exactly as before.

- [#671](https://github.com/edspencer/paddock/pull/671) [`aa607e4`](https://github.com/edspencer/paddock/commit/aa607e47e061801f77298aa349d657b403577fe1) Thanks [@edspencer](https://github.com/edspencer)! - Stop the sidebar project list flashing to skeletons on every turn (#572)

  `ProjectsProvider.refresh()` set `loading = true` unconditionally, and the
  sidebar renders three pulsing placeholders _instead of_ the project list
  whenever that flag is set. `ProjectView` refreshes the list from three
  turn-lifecycle callbacks (`onSessionStarted`, `onSessionEstablished`,
  `onTurnComplete`), so the whole nav blanked and re-populated **twice per keeper
  turn** — measured on a live instance with a `MutationObserver`.

  `loading` was doing double duty: "we have never loaded the list" and "we are
  re-checking a list we are already showing". Only the first deserves a
  placeholder. It now stays true only until the first _successful_ fetch lands;
  after that, refreshes revalidate quietly and the previous list stays on screen.
  A first load that fails still gets the placeholder back on retry, having nothing
  to show in the meantime.

- [#667](https://github.com/edspencer/paddock/pull/667) [`5fc3371`](https://github.com/edspencer/paddock/commit/5fc3371260b5124607d2b5bdd30dc71439bb28fd) Thanks [@edspencer](https://github.com/edspencer)! - Show the "conversation compacted" chip below the `/compact` that produced it

  Claude Code appends a compaction's records to the session JSONL at positions
  _preceding_ the command line that triggered it, while stamping them with the time
  compaction _finished_. Paddock renders in file order, so a compacted chat read
  backwards: the 🗜️ boundary sat above the `/compact` chip, as though the
  conversation had been compacted before anyone asked for it, with the two records
  up to three minutes apart in wall-clock terms (#630).

  The transcript's grouping step now moves a compaction boundary one slot past the
  `/compact` echo that produced it. It is a targeted swap, not a re-sort: a boundary
  with no echo to pair with (an auto-compaction) and a `/compact` whose compaction
  never completed are both left in file order, and no turn is added or dropped.
  Purely cosmetic — the summary body stays tucked behind its disclosure exactly as
  before.

- [#670](https://github.com/edspencer/paddock/pull/670) [`def27b8`](https://github.com/edspencer/paddock/commit/def27b874482c628d8801084217759f362e526e6) Thanks [@edspencer](https://github.com/edspencer)! - Stop describing a trigger with no tools as an enforced tool-less agent (#647)

  Paddock expresses "no tools" as `allowed_tools: []`, and both herdctl runtimes emit
  the allow-list **only when it is non-empty** — the CLI runtime guards
  `if (allowed_tools?.length)` before pushing `--allowedTools`, and `toSDKOptions`
  does the same before setting `allowedTools`. An empty list is therefore
  indistinguishable from an unset one: the agent runs with Claude Code's default
  tools, not a deny-all.

  The source comments and the Triggers UI claimed the opposite. Nothing about the
  runtime changes here — only what Paddock says about it:

  - The trigger capability banner no longer promises a `tools: []` event trigger
    "can only read its prompt and respond (no file, shell, or MCP access)". It now
    says no tools were declared, that an empty list is not a restriction, and that
    the prompt and max turns are the real bounds.
  - The Triggers list shows "No tools" instead of "Tool-less", and the tool picker's
    help text spells out that leaving everything unchecked is not a deny-all.
  - The comments on `triggerToAgentToolConfig`, `hookToAgentToolConfig` and the
    sweeper config describe what actually happens. The sweeper's tool-less-ness is
    restated in terms of the properties that do hold: no injected MCP servers,
    `max_turns: 4`, a system prompt that forbids tool use, and a non-interactive
    `claude -p` run that cannot answer a permission prompt.

  Making a tool grant enforceable at all is tracked separately in #319; this change
  deliberately implements no enforcement.

- [#669](https://github.com/edspencer/paddock/pull/669) [`e873f98`](https://github.com/edspencer/paddock/commit/e873f98b7e12bb2204561d8493895939989e2f60) Thanks [@edspencer](https://github.com/edspencer)! - Stop Settings claiming an instance default it hasn't fetched yet

  A project's Settings tab seeded the three inherited instance defaults with
  literals, so before `GET /api/models` returned it told you your box defaults to
  drive mode **Batch** — a claim about instance configuration, and a wrong one:
  the box-wide default has been `session` since v0.36. The literal was written
  when `batch` was the default and was never updated, which is exactly the drift a
  hard-coded copy invites (#587).

  The pre-fetch state is now genuinely unknown (`null`) rather than a guess, and
  renders as such: `Global default (loading…)`, `Instance default (loading…)` and a
  short "Loading the …" hint in place of the "Inheriting …" prose, matching the
  existing _"Loading the instance model list…"_ idiom in the same pane. Applied to
  drive mode, max spawn depth and the curation budgets alike, so none of them can
  drift the next time a server default changes. Nothing about what is persisted
  changes — the placeholder was never saved.

## 0.60.0

### Minor Changes

- [#663](https://github.com/edspencer/paddock/pull/663) [`59aa52f`](https://github.com/edspencer/paddock/commit/59aa52f4a0aad1d0436efcfa389c459f912ca795) Thanks [@edspencer](https://github.com/edspencer)! - Confirm native-chat imports before they happen, and let them be undone

  "Import N native chats" was a permanently-visible sidebar button that imported
  everything on one click, showed nothing about what it was about to take, and
  could not be undone from the UI. The absence of a dismiss was deliberate and
  well-argued — a live count beats a stale dismissal flag — but that reasoning
  assumes the count is trustworthy, and it has not been: the same button has
  offered Paddock's own sweeper output and another instance's chats.

  The click now opens a dialog listing the candidate sessions grouped by the
  directory they came from, with their date, size and first message. Everything
  starts ticked, because "yes, all of it" really is the common case. The source
  path is the load-bearing detail — it is what makes "these are from a scratch copy,
  not my checkout" visible before anything is imported rather than after.

  A successful import offers **Undo** on its toast, which releases the adoptions and
  deletes the copies the import placed. The user's own `~/.claude` history is never
  touched. Which files an undo may delete is decided server-side from what the
  import actually did, so the request carries session ids and no paths; the offer
  lives in memory and expires with a restart, in which case undo reports that there
  was nothing to undo rather than acting on a stale record.

  API changes:

  - `GET …/adoptable-chats` sources gain a `sessions` array (`mtime`, `preview`,
    `autoName`, `sizeBytes`) alongside the existing `sessionIds`.
  - `POST …/adopt-chats` accepts `sessionIds` to import a chosen subset.
  - `POST …/unadopt-chats` is new.

  The live count is unchanged, and there is still no dismiss state.

### Patch Changes

- [#657](https://github.com/edspencer/paddock/pull/657) [`4dac0ba`](https://github.com/edspencer/paddock/commit/4dac0ba251ef1490a814167ab04fef5c42aba875) Thanks [@edspencer](https://github.com/edspencer)! - Fix an expanded `send_file` card flickering forever and breaking chat scrolling

  A sent file taller than 360px re-rendered **once per animation frame, for as long
  as it was on screen**, strobing between its bounded (360px, scrollable) and
  unbounded (full-height) layouts. Because the transcript's height changed by the
  same amount every frame, scroll anchoring fought it and scrolling the chat became
  unusable.

  `ResizableBox` returned two structurally different trees for the two cases, so
  React reused one host `<div>` for both roots — and the `ResizeObserver`, whose
  effect never re-ran (its only dependency is the parent-owned `children`), kept
  measuring that node after it had become the wrapper carrying `style.height`. The
  measurement was therefore circular: it read back the applied height, `360 > 360`
  was false, the box unbounded itself, measured the full height, bounded itself
  again, forever (#656).

  The tree shape is now the same in both cases — bounding only toggles classes and
  attributes — so the measured element is always the content, which nothing sizes.
  That also stops `children` being remounted on every flip, which is what left an
  async Mermaid render inside a long markdown body permanently blank (#644).

## 0.59.1

## 0.59.0

## 0.58.0

## 0.57.0

### Minor Changes

- [#645](https://github.com/edspencer/paddock/pull/645) [`cbdccd5`](https://github.com/edspencer/paddock/commit/cbdccd5c721e6a208a01daa0c1ae099079789eef) Thanks [@edspencer](https://github.com/edspencer)! - Tell the agent it is in a browser: a small, overridable environment system prompt

  Paddock injected no system prompt of its own. On a default instance the keeper ran
  on Claude Code's stock preset, which is written for a terminal — nothing anywhere
  told it that its replies render as GitHub-Flavored Markdown in a browser, that a
  bare `#123` is dead text, or that `mcp__paddock__send_file` puts an image on screen.

  An audit of the 100 most recent chats on the dogfood instance (3,944 assistant
  messages, 2.1 MB of prose) measured the cost: **4,440 bare `#123` refs against 155
  markdown links**, and **194 image reads / 138 screenshots with zero images ever sent
  to a user**. In one chat that gap cost a full re-work round — the agent read 17 QC
  frames, showed none, misread one, and shipped a regression the user then had to
  screenshot themselves.

  Paddock now appends a two-rule environment prompt to every keeper turn — _show,
  don't describe_ and _make clickable things clickable_. Both rules come from that
  audit; several plausible-sounding extras ("no ANSI colour", "don't paste long
  content", "use markdown structure") were measured, refuted, and cut.

  Configure it with `PADDOCK_ENVIRONMENT_PROMPT` / `environmentPrompt:`, or from
  **Settings → Capabilities → Environment prompt**, which gains a multi-line editor.
  Unlike every other setting, blank is meaningful: omit the key for the built-in text,
  set a string to replace it, set an empty string to append nothing.

  One caveat, documented rather than papered over: on `driveMode: batch` the append is
  withheld while the native system prompt is on. herdctl's CLI runtime has no
  `--append-system-prompt`, so sending it there would swap Claude Code's entire coding
  preset for two rules. The default `session` drive mode — what every chat actually
  uses — appends properly.

## 0.56.0

### Minor Changes

- [#558](https://github.com/edspencer/paddock/pull/558) [`f061cd6`](https://github.com/edspencer/paddock/commit/f061cd6dfdeb5ba83ede8fcf8638fea1e9d77b30) Thanks [@edspencer](https://github.com/edspencer)! - Remove `scratch` entirely, including the legacy `scratchDir` config field (#549)

  Scratch was retired as a feature in #516 Phase 6 and the root became a
  first-class workspace in #533. The code was already gone; what survived was one
  deliberately-kept config field and 232 stale references across 67 files.

  **Removed config:** `PADDOCK_SCRATCH_DIR` / `scratchDir:` no longer exists. It
  was kept so an existing env or config file wouldn't fail validation — back-compat
  for an install base that doesn't exist.

  **Stale settings are IGNORED, not fatal.** An instance that still sets
  `PADDOCK_SCRATCH_DIR`, or whose `paddock.config.yaml` still carries `scratchDir:`,
  boots normally and the value has no effect. This isn't a shim: config resolution
  is pull-based on both layers — env vars are read by name, and the YAML file is
  parsed into a loose record that is only ever read, never enumerated or validated
  against a schema — so a deleted key is simply never looked at. The trade-off is
  that a typo'd key is equally silent; that is deliberate, because an operator
  should not be locked out of a running instance by a stale line in an old env file.

  **Also removed:** the dead `isProjectChat` prop on the web `ChatPane` (its
  `false` branch only ever described a scratch chat and no caller passed it), and a
  dead flow in the manual `scripts/e2e.mjs` smoke script that waited on a "One-off
  chat" heading the app no longer renders.

  **Your data is untouched.** On an existing instance, old one-off transcripts
  still sit at `<dataDir>/scratch/.chats`. They have been unreferenced and unlisted
  since #516 and nothing in this change deletes them — if you don't want them, that
  directory is safe to remove by hand.

## 0.55.0

### Minor Changes

- [#621](https://github.com/edspencer/paddock/pull/621) [`28f4305`](https://github.com/edspencer/paddock/commit/28f4305c0fd6cb1d0b837ebbf1d115d855ba72f4) Thanks [@edspencer](https://github.com/edspencer)! - Import the Claude Code CLI chats you already have into a project.

  A project is backed by a working directory, and you very often already have
  terminal `claude` history for it — or for your own checkout of the same repo,
  somewhere else entirely. Until now that history was invisible here.

  When a workspace has importable sessions, an **Import _N_ native chats** button
  appears at the top of its chat list. One click, no confirmation dialog: the
  chats are imported, the list refreshes, and a toast reports how many arrived.
  The count is live rather than a dismissable prompt, so it returns if you accrue
  new terminal sessions later. Imported chats carry an **Imported** badge so they
  are distinguishable from chats started here.

  Underneath are two new workspace-scoped routes:

  - `GET …/adoptable-chats` → `{ count, sources, filtered }` — what this project
    could import, per source working directory. Recomputed on every call, so the
    count reaches 0 only because there is genuinely nothing left.
  - `POST …/adopt-chats` → `{ adopted, skipped }` — imports every detected source,
    or just the one you name.

  Both are on the same dual-mounted plugin as the rest of the chat routes, so the
  **root workspace** gets them for free. `npm run import-chats -w @paddock/server`
  is the headless equivalent, for when the transcripts and the server do not share
  a filesystem view — a containerised instance only sees what is mounted.

  This requires **`@herdctl/core@5.29.0`**, which is where the session-adoption
  primitives live, along with the `CLAUDE_CONFIG_DIR` fix without which _resuming_
  an imported chat fails outright.

  Detection looks at the project's own working directory plus any Claude
  transcript folder whose _recorded_ working directory matches the project — by
  checkout name for a repo-backed project, by exact path for a notebook one. The
  recorded cwd is read out of the transcript rather than derived from the folder
  name, because that encoding is lossy and non-invertible: `/a/b-c`, `/a-b/c` and
  `/a/b/c` all share one folder. That same lossiness is why sources are
  de-duplicated by resolved folder and sessions by id — otherwise a colliding pair
  of directories offers every session twice. Empty and slash-command-only
  transcripts are withheld as noise and listed under `filtered`, so a lower count
  always has an explanation. Results are cached on transcript-directory mtimes and
  dropped after every import.

  Transcripts are **copied**, never moved: your `~/.claude` history stays intact,
  and the copies keep their original timestamps so imported chats sort by when
  they actually happened.

  Two fixes ride along, both about timestamps and homes being taken for granted:

  - The configured `CLAUDE_HOME` is now resolved once and handed to the engine.
    It previously honoured the variable for its own paths while the engine fell
    back to `~/.claude`, so with a non-default home chats could list from one
    directory and open empty from another. Invisible whenever the two happen to
    be the same directory, which is most deployments.
  - Relocating an existing transcript directory into a project now preserves file
    timestamps. It didn't, and mtime is both the chat-list sort key and the cache
    key for titles and previews — so a months-old archive collapsed to "today".
    Note the narrow scope: registering an agent still **moves** a matching
    `~/.claude` transcript directory into the project. This stops that move
    mangling the dates; it does not stop the move. Paddock owning its own Claude
    home is filed separately as #620.

  Imported chats are marked with a new `adopted` provenance origin. It counts as a
  root (nothing here created it) and as _attended_ (you ran it yourself), so
  importing 22 sessions never claims 22 things ran while you were away.

## 0.54.2

### Patch Changes

- [#605](https://github.com/edspencer/paddock/pull/605) [`457cdbd`](https://github.com/edspencer/paddock/commit/457cdbd7add0be5f00c96dc4443f0c27749e8a31) Thanks [@edspencer](https://github.com/edspencer)! - A sub-agent's own transcript now decides whether it is running, and what its
  duration is — not the parent's turn.

  Two visible bugs, one root cause. The SDK **backgrounds sub-agents by default**,
  so the parent routinely finishes its reply while they keep working. Both the
  "running" state and the displayed duration were derived from the parent instead
  of the sub-agent.

  **The bar vanished the moment the parent replied.** Liveness hung off the chat's
  `streaming` flag. Captured frame timeline for a turn that launches two research
  sub-agents and then answers:

  ```
   13.5s  chat:tool_call   Agent  durationMs=38     ← launch-ack
   22.6s  chat:complete                             ← both sub-agents still working
   22.6s  chat:active      running=false            ← client sets streaming=false
   34.9s  chat:active      running=true             ← background stream reopens
  ```

  For those ~12 seconds the chat looked idle: the running-sub-agents bar
  disappeared and every card snapped from "RUNNING" to a finished state, while the
  work carried on for another six minutes.

  **Cards advertised the launch-ack as the runtime.** `durationMs` on the launching
  `Task`/`Agent` call is the time to _spawn_ a background sub-agent (~30ms), not the
  time it ran. A four-minute research sub-agent displayed "38ms" until a reload
  replaced it via the history join.

  Liveness and duration now come from the sub-agent's own transcript, which the
  running-sub-agents bar already polls:

  - a sub-agent stays "running" while its transcript grows, and only settles after
    6 silent polls (~12s) once the chat is no longer live — so it survives the
    parent's `chat:complete`;
  - duration prefers the server's final figure, else the transcript's first→last
    span, else **shows nothing**. An honest gap beats a wrong number, and the
    launch-ack is never used for a sub-agent card.

  Polling is armed only for sub-agents seen while the chat was live, so reopening a
  finished chat still fetches nothing until you expand a card (the lazy-load
  contract), and it stops entirely once everything has settled.

  Verified live: bar continuously present 9s→393s across the parent's completion,
  zero samples of a hidden bar while a card read RUNNING, and final durations of
  4m 34s / 5m 55s instead of ~30ms.

  Known limitation, deliberately left visible: a sub-agent that goes completely
  silent for >12s while the parent is idle settles early and drops out of the bar
  (its card keeps the elapsed time it reached). The robust fix is server-side —
  `chat:active` should not report `running: false` while background sub-agents are
  still in flight.

## 0.54.1

### Patch Changes

- [#607](https://github.com/edspencer/paddock/pull/607) [`c456b3e`](https://github.com/edspencer/paddock/commit/c456b3e0e66f7914646fa2eb32f7ac9b78ba8a5e) Thanks [@edspencer](https://github.com/edspencer)! - Lead the Home tab with what needs you: running chats, then unread chats.

  **The feeds.** Home used to open on a list of recent chats — the same list the
  sidebar already shows in full, so the front door duplicated the furniture and
  buried the signal. It now opens on the two states that actually want a decision:
  chats with a **live turn**, then chats holding an **unread reply**. Everything
  else (files, notes) follows.

  Both feeds come from one new route, `GET <base>/chats/attention`, scoped to the
  workspace's **subtree**. A workspace's key is its path relative to the projects
  root, so its descendants are exactly the workspaces it prefixes — and the root's
  key is `""`, which prefixes every key there is. The root's Home is therefore
  fleet-wide (every project's live work plus its own) and a project's Home is
  scoped to itself, through one handler and one component that never learn which
  they are rendering. No `root` flag, no second implementation to drift. Nesting,
  when it lands, gives an intermediate workspace the same behaviour for free.

  `running` is read from the live session hub rather than inferred from
  timestamps, so it cannot disagree with the streaming dots. A chat is never in
  both lists — a live turn hasn't landed a reply yet, so running wins.

  **Why this could not have worked before.** The client only ever opened its
  WebSocket from `subscribe()`, so landing on Home with no chat pane mounted
  opened _no socket at all_ and the running set stayed permanently empty — and an
  empty running set is indistinguishable from a quiet instance, which is why the
  in-flight badge appeared merely unreliable rather than dead (#573). Watching the
  active set is now itself a reason to hold a socket, and the server already
  replays its whole running snapshot to every socket on connect, so the first
  paint is correct.

  **The Projects section is gone from Home.** It hosted the app's ONLY New Project
  button, so that moved to the sidebar's Projects header — replacing the project
  count, which answered a question nobody asks while the list sits directly
  beneath it. Same `+` affordance as the chat sidebar's New chat, in the same
  place relative to its list.

  **Notes.** `OVERVIEW.md` now renders on Home beside `CHANGELOG.md`, both
  collapsible with the choice remembered per workspace. It rides the workspace
  payload next to `changelog`, so the two can never render a beat apart. The old
  bottom "Overview" card (a summary plus a metadata table) is deleted — it
  described the workspace rather than offering a way into it, and Settings already
  owns editing that.

## 0.54.0

### Minor Changes

- [#598](https://github.com/edspencer/paddock/pull/598) [`8b2fd83`](https://github.com/edspencer/paddock/commit/8b2fd838ee2c9d546bd841b3d96d364e372d218f) Thanks [@edspencer](https://github.com/edspencer)! - Rename the "keeper" config, env, and API surface (#585). **Breaking** — the old
  names are gone, with no aliases: pre-1.0, a minor may break the one before it.

  Env vars:

  | before                         | after                   |
  | ------------------------------ | ----------------------- |
  | `PADDOCK_KEEPER_DRIVE_MODE`    | `PADDOCK_DRIVE_MODE`    |
  | `PADDOCK_KEEPER_NATIVE_PROMPT` | `PADDOCK_NATIVE_PROMPT` |

  Config file (`paddock.yaml`) and the instance-settings key: `keeperDriveMode` →
  `driveMode`. An instance that still sets the old key falls back to the built-in
  default (`session`) rather than erroring.

  `GET /api/models` response fields: `keeperDefault` → `defaultModel`,
  `keeperDriveModeDefault` → `driveModeDefault`. The self-MCP `create_project`
  result field `keeperRegistered` → `agentRegistered`. Server and web change
  together, so no client sees a mixed contract.

  Internal constants and functions follow the same rule: `KEEPER_DEFAULT_MODEL` →
  `DEFAULT_MODEL`, `KEEPER_DEFAULT_DRIVE_MODE` → `DEFAULT_DRIVE_MODE`,
  `KEEPER_DEFAULT_MAX_TURNS` → `DEFAULT_MAX_TURNS`, `KEEPER_DEFAULT_PERMISSION_MODE`
  → `DEFAULT_PERMISSION_MODE`, `KEEPER_DEFAULT_DOCKER` → `DEFAULT_DOCKER`,
  `KEEPER_DENIED_TOOLS` → `DENIED_TOOLS`, `resolveKeeperDefault` →
  `resolveDefaultModel`, `buildKeeperConfig` → `buildAgentConfig`,
  `ensureKeeperModel` → `ensureAgentModel`.

  The `keeper-` agent-name prefix is deliberately untouched: it is persisted in
  herdctl job records, `state.yaml`, session directories, and six sidecar stores
  keyed `keeper-<slug>\0<sessionId>`. Renaming it would orphan all of that.

  Also: three source files embedded a **raw NUL byte** in a string literal, which
  made ripgrep classify them as binary and skip them silently — `ws.ts` was missed
  by every `keeper` audit for that reason alone. They now spell it `\u0000`, the
  convention the other sidecar stores already used. Same runtime value; the files
  are greppable again.

- [#598](https://github.com/edspencer/paddock/pull/598) [`8b2fd83`](https://github.com/edspencer/paddock/commit/8b2fd838ee2c9d546bd841b3d96d364e372d218f) Thanks [@edspencer](https://github.com/edspencer)! - Retire "keeper" from the user-facing copy (#585). The UI now says **Claude** —
  Paddock is a thin layer over Claude Code, so the persona was inventing a second
  actor that does not exist.

  | before                                                                  | after                                                                      |
  | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | `Message the keeper agent…`                                             | `Message Claude…`                                                          |
  | `…stream live from the keeper agent`                                    | `…stream live from Claude`                                                 |
  | `No files yet. Files the keeper agent writes appear here.`              | `No files yet. Files Claude writes appear here.`                           |
  | `Runs appear here once the keeper starts finishing turns.`              | `Runs appear here once Claude starts finishing turns.`                     |
  | `consulting the keeper` (composer spinner)                              | `consulting Claude`                                                        |
  | `The keeper will respond again after the quota resets.`                 | `Claude will respond again after the quota resets.`                        |
  | Settings section `Keeper agent`                                         | `Claude`                                                                   |
  | `How this project's keeper agent runs. Changes re-register the keeper.` | `How Claude runs in this workspace. Changes take effect on the next turn.` |
  | `Keeper tools` (trigger capability badge)                               | `Claude's tools`                                                           |
  | `Keeper default` (trigger model placeholder)                            | `Workspace default`                                                        |
  | `runs as the keeper (full tools)`                                       | `runs as Claude (full tools)`                                              |

  Where a sentence did not need an actor the word is simply gone rather than
  substituted — "a dedicated keeper agent" drops out of the empty-projects copy,
  "a single keeper run" becomes "a single run".

  Server-authored strings the user reads follow the same rule: the turn-notice
  messages (`Claude reached its turn limit…`, `Claude's turn failed…`), the
  registered agent's description and system prompt, and the herdctl fleet
  description.

  Behaviour is unchanged. The `keeper-` agent-name prefix is untouched — it is a
  persisted on-disk encoding, not a word the user sees.

### Patch Changes

- [#595](https://github.com/edspencer/paddock/pull/595) [`d24d48f`](https://github.com/edspencer/paddock/commit/d24d48f746d11f964c59f8d870aa51a8a8a45fd4) Thanks [@edspencer](https://github.com/edspencer)! - Stop a foreground sub-agent leaking its steps into the parent transcript, and
  show what running sub-agents are doing.

  **The leak.** Launching a sub-agent with `run_in_background: false` duplicated
  every one of its steps: once inside the sub-agent card (correct) and once as
  top-level rows of the _parent_ transcript. A three-step sub-agent therefore
  printed three phantom `Read`/`Bash` rows next to the card that already contained
  them.

  The filter that prevents this (`isSidechainMessage` — a nested step carries
  `parent_tool_use_id`) existed, but only ONE of the five live turn paths called
  it: the background sink. That gap was deliberate, and wrong. A comment on the
  sink recorded the premise that only a _backgrounded_ `Task` streams its nested
  steps inline, a foreground one being routed by herdctl to "a SEPARATE sidechain
  session, never the main turn stream". Under SDK streaming mode that is false — a
  foreground `Task` streams its steps inline on whichever turn stream launched it,
  so every unfiltered path duplicated them. The filter now runs on all five
  (`chat:send`, slash-command, scheduled wake, `startAgentTurn`, background sink),
  with the false premise corrected in place so it cannot be re-derived.

  The bug was live-only, which is why it survived: history has always filtered
  sidechain steps, so a reload "healed" the transcript and the duplication read as
  a streaming glitch. The regression test therefore asserts over WS **frames**, not
  the persisted transcript — the persisted view was never broken. A new
  `[[SUBAGENT]]` directive in the test `claude` emits a real foreground Task with
  inline sidechain steps to drive it.

  Skipping these messages also keeps a sub-agent's context out of the parent's live
  context meter, which `foldTurnUsage` would otherwise latch onto as its max — the
  same shape as the #398 inflation, corrected only on refresh.

  **Seeing what a sub-agent is doing.** A sub-agent could work for minutes behind a
  collapsed card showing only a cost, with no indication of progress — and the card
  is often scrolled well out of view. A live bar above the composer now lists each
  RUNNING sub-agent with its latest step and step count, updating as it works.
  Tapping a row scrolls that sub-agent's card into view, expands it, and flashes it
  so the eye lands on it (`prefers-reduced-motion` drops the flash).

  Polling is hoisted out of the card into the chat, so it stays at one request per
  sub-agent per tick and a card reads the shared result instead of opening a second
  poll — expanding a card now costs no extra fetching. The bar and the card decide
  "is it running" through one shared `isSubagentRunning` predicate, so they cannot
  disagree the way the five stream handlers did.

## 0.53.0

### Minor Changes

- [#559](https://github.com/edspencer/paddock/pull/559) [`5011e64`](https://github.com/edspencer/paddock/commit/5011e64ea347426ba47be649518e5a47432a4a53) Thanks [@edspencer](https://github.com/edspencer)! - Give the sidebar's **Home** link the unread / in-flight badge every project row
  already has.

  The root is a workspace with its own chats, so its sidebar row should say what
  every other workspace's row says: an accent pill for unread replies, a spinner +
  count for turns in flight, and **nothing at all** when it is quiet. It is the
  same `ProjectBadges` component with the same thresholds and the same accessible
  labels — not a root-shaped lookalike.

  **The data plumbing is the actual change.** The badge is folded from each
  workspace's compact `chatTurns` list, which arrives on `GET /api/projects` — and
  that route enumerates the root's _children_, so the root's own signal never
  reached the client. It does now, as a sibling `root` field on the same response,
  built by the same `buildChatTurns` fold as every child. The root stays out of the
  `projects` array (it belongs in neither the grid nor the sidebar list), but its
  counts land in the same badge map under the empty key, so `useProjectBadges`
  computes Home and a project row in one pass with no branch on which is which.

  This also removes a round-trip: the projects context used to follow every list
  fetch with a full `GET /api/root` workspace-detail request — `changelog` and
  `chats` included — and throw everything but the metadata away. One call now
  serves both.

  `""` is a real, routable workspace key, so the lookup is `badges.get(ROOT_KEY)`
  and the server's fold takes the key as an ordinary argument; a falsy guard
  anywhere on that path silently drops the root, which is the failure mode the new
  tests are pointed at.

### Patch Changes

- [#577](https://github.com/edspencer/paddock/pull/577) [`1d52811`](https://github.com/edspencer/paddock/commit/1d5281178fe750e780c4b6e16edceb03c498cfe3) Thanks [@edspencer](https://github.com/edspencer)! - Drop four back-compat shims that no longer have anything to be compatible with
  (#553). Two of them change the wire.

  The project DTO no longer carries `created`. It was a dual-emit alias of
  `started` — populated with the identical value, stripped again on write, and
  documented as a reconciliation between two old specs. Its one consumer rendered
  it as a read-only row _next to_ `started`, so the project Settings tab showed
  **"Started" and "Created" as two adjacent rows containing the same date**. That
  duplicated row is gone; `started` remains, unchanged, as the creation date.

  `GET /api/models` no longer returns `sweeperDefault`. Nothing read it — the
  sweeper's model is resolved server-side and was never selectable in the UI, so
  the field only ever described a decision the client couldn't influence.

  The two internal shims: the `SWEEPER_MODEL` alias of `SWEEPER_DEFAULT_MODEL` is
  gone (the one importer now uses the canonical constant), and the five instance
  defaults on `getModels()` — `keeperDriveModeDefault`, `maxSpawnDepthDefault`,
  `recoveryDefault`, `attachmentsDefault`, `curationDefault` — are now **required**
  rather than optional "for back-compat with older servers". There is no older
  server; the server sends all five unconditionally. The `??`/`if` guards that
  existed to tolerate their absence are gone with them, which also means a fixture
  can no longer omit one and silently exercise a shape the server never sends.

- [#571](https://github.com/edspencer/paddock/pull/571) [`4e78c30`](https://github.com/edspencer/paddock/commit/4e78c301d0aa13934d54edee6542ed8ad713c522) Thanks [@edspencer](https://github.com/edspencer)! - Promoting a chat to a project now adds it to the sidebar immediately (#566)

  The promote action always did the right thing server-side — the project was
  created and the chat's transcript re-homed — but the client only navigated, so
  the new project was missing from the left nav until you reloaded. The project
  list has no push channel, so the handler now inserts the returned project into
  the projects context, exactly as the New Project path already does.

  Two further bugs in the promote dialog, both from one over-subscribed effect
  that reset the form on almost any re-render rather than only on open:

  - The project name you typed was silently reverted to the chat's name whenever
    the parent re-rendered — which, in a live chat view, is often.
  - A failed promote could never show its error: the reset ran again as the submit
    left its busy state and wiped the message one render after it was set.

- [#577](https://github.com/edspencer/paddock/pull/577) [`1d52811`](https://github.com/edspencer/paddock/commit/1d5281178fe750e780c4b6e16edceb03c498cfe3) Thanks [@edspencer](https://github.com/edspencer)! - Remove the legacy `target` WebSocket alias for `projectSlug` (#551). Every
  server→client frame carried `target` as a byte-for-byte duplicate of
  `projectSlug`, and five client→server message types accepted it as an alias — a
  compatibility surface for "early frontends" that do not exist, since the server
  and the SPA ship as one artifact from one repo.

  Frames now carry `projectSlug` only. Nothing read the alias: the web client sent
  `projectSlug` at every send site, and the single server→client fallback was
  unreachable because `projectSlug` is required on every emitted payload type and
  every emit site sets it — including the root workspace's `""` (a _present_ empty
  string) and `"?"` on the invalid-frame path.

  The `chat:send` payload documentation now also records that `""` is the legal
  ROOT workspace key, and that it must be tested with `=== undefined` rather than
  for falsiness — the fact most likely to be re-broken, and the one the comment
  omitted.

## 0.52.0

### Minor Changes

- [#542](https://github.com/edspencer/paddock/pull/542) [`bea2276`](https://github.com/edspencer/paddock/commit/bea2276c55dcb5b8fd697811d405fb409c65c938) Thanks [@edspencer](https://github.com/edspencer)! - Chat list: a running-chats filter on the count badge, and a nested/flat view toggle

  The "Chats" count badge splits when a turn goes live: total on the left,
  running count on the right, and the right half toggles the list down to just the
  chats working right now. Running chats were always findable by hunting for
  spinning rings down the sidebar; now they are a target you can hit.

  The filtered view renders FLAT. A running child sitting under its running parent
  would reintroduce exactly the indentation the filter exists to remove, so the
  running view drops nesting entirely — and it keeps the chat you currently have
  open pinned in, so it cannot vanish from under you the moment its turn finishes.
  Filtering to running composes with search rather than fighting it, and when the
  last turn ends the list says "No chats are running" and offers the way back,
  because the filter is sticky and can outlive the work it was filtering for.

  Nesting itself is now optional: a second toolbar button beside "+" toggles the
  list between the nested tree and a flat one. Both preferences are per-browser
  and global, not per-project — how you like to read a list is not a per-project
  fact.

- [#515](https://github.com/edspencer/paddock/pull/515) [`6c21fcd`](https://github.com/edspencer/paddock/commit/6c21fcd94e06088f87648df7385ca63dcde4fb7f) Thanks [@edspencer](https://github.com/edspencer)! - feat(chats): subtree actions, detach-from-parent, and a real tooltip for the chat tree (#508).

  The nested chat list (#485) could only act on one chat at a time. Archiving a
  parent left its children behind — they lose their parent from the active
  population, so `buildChatTree` promotes them to roots and the family silently
  scatters back into the main list — and there was no way to say either "take the
  whole family with it" or "keep this one out of it".

  **Shift-click** on archive, delete, or mark-read/unread now applies to a chat and
  **all** its descendants, recursively, matching the count the collapsed-row pill
  already shows. A plain click is unchanged. Delete goes through a count-aware
  confirmation — "Manager and its 3 nested chats will be permanently removed" —
  because a collapsed parent means shift-deleting can destroy chats that aren't
  even on screen, and there is no undo.

  Those actions run through new **batch endpoints** (`POST
…/chats/batch/{archive,unread,delete}`) rather than a client-side loop. The flag
  sidecars commit the whole set in one write, so a parent and its children can't
  end up in different states; the delete route can't be atomic (filesystem) so it
  attempts every id and reports back which ones it couldn't remove, and the client
  only drops what was actually deleted.

  **Detach** (`POST …/chats/:sessionId/detach`, an unlink action on any nested row)
  promotes a chat to the top level with its own subtree intact, so a family can be
  archived _except_ one chat. It is persisted as an explicit override that is
  checked AHEAD of both parent-resolution tiers — clearing the recorded edge would
  not work, because most live edges are _inferred_ from the kickoff message and
  would simply be re-derived on the next load. Nothing is destroyed, so re-attach
  is just clearing the flag.

  The delete dialog also names the nested chats it will **keep**: deleting a parent
  without its children re-homes them to the top level, and an irreversible action
  shouldn't restructure the list silently. That covers a plain delete of a parent
  (previously silent) as well as a subtree delete narrowed by an active search.

  Single-chat delete now clears a chat's detach override too, alongside the
  archived/starred/unread flags it already cleared, so a recycled session id can't
  start life detached from a parent it never had.

  Discoverability comes from a new shared **`Tooltip`** component, which replaces
  every native `title=` in the chat list: themed, portalled out of the sidebar's
  scroll container, rich enough to carry "Archive · **Shift-click** to archive all
  4", and shown only on the rows that actually have descendants. The same hint is
  in each button's accessible name, so the affordance also reaches Shift+Enter from
  the keyboard.

- [#539](https://github.com/edspencer/paddock/pull/539) [`bd387dc`](https://github.com/edspencer/paddock/commit/bd387dc1093061186167ea598c40d6a1f441da8b) Thanks [@edspencer](https://github.com/edspencer)! - Fold the projects grid into root Home, split instance **Config** from workspace
  **Settings**, and fix a phantom scrollbar on the tab strip.

  **Navigation.** The sidebar's "New Project" and "New root chat" buttons are
  replaced by a single **Home** link to `/`. Both actions live on root Home now —
  the projects grid there carries "New Project", and Home's Chats section carries
  "New chat" — so the sidebar no longer duplicates them.

  **The Projects tab is gone.** The root workspace's tab bar leads with **Home**,
  and the projects grid is a _section_ of the Home pane rather than a tab of its
  own. `/projects` is a permanent redirect to `/`, so links and bookmarks from
  v0.51.0 still land on the list. Home's sections read Chats → Projects → Files →
  CHANGELOG.md → Overview: Chats lead because that section is on every workspace's
  Home, so the page opens the same way whether or not there are children, and
  Overview trails because it describes a workspace rather than offering a way into
  one. Only a workspace with children renders the Projects section.

  **`config` and `settings` are now two different screens, named for the files
  they write.** v0.51.0 rendered the instance-wide `paddock.config.yaml` form as a
  second section beneath the ROOT workspace's own settings form — two save bars,
  one page inside another. They are split:

  |              | Writes                       | Lifecycle                         | Where                         |
  | ------------ | ---------------------------- | --------------------------------- | ----------------------------- |
  | **Config**   | `paddock.config.yaml`        | frozen at boot — restart required | `/config` (sidebar gear)      |
  | **Settings** | a workspace's `project.yaml` | hot-applied on save               | that workspace's Settings tab |

  The sidebar's gear is relabelled **Config** and points at `/config`; `/settings`
  is the root workspace's Settings tab, now identical to any project's. This also
  fixes the tab not scrolling: `InstanceConfigForm` is a fragment whose `min-h-0
flex-1 overflow-y-auto` body only works as a flex-column child, so stacked in a
  plain `<div>` it grew to full content height, refused to shrink, squashed the
  workspace form to **zero height**, and left nothing on the tab able to scroll.
  One pane per tab, and the problem cannot recur.

  **No more phantom scrollbar on the tab strip.** `overflow-x: auto` promotes
  `overflow-y: visible` to `auto`, so the strip is a vertical scroll container too
  — and a scroll container's scrollable area is the union of its descendants'
  _border_ boxes, which negative margins do not pull in. Each tab's `-mb-px`
  (which overlaps the active underline onto the strip's 1px rule) therefore left
  1px of scrollable overflow and a scrollbar with nothing to scroll. The -1px now
  hangs off the scroller itself, whose parent is not a scroll container: identical
  geometry, `scrollHeight === clientHeight`, horizontal tab scrolling intact.

### Patch Changes

- [#538](https://github.com/edspencer/paddock/pull/538) [`4f67324`](https://github.com/edspencer/paddock/commit/4f67324fd132fe5e7b5c79b79ec92ed4e3ad6d76) Thanks [@edspencer](https://github.com/edspencer)! - Stop computing usage rings nobody can see (#537). `GET
/api/projects/:slug/chats/usage` computed the context-ring fill for **every**
  chat in a project, and there is no stored counter for that — each session's fill
  is derived by streaming its transcript (and its sub-agents') end to end and
  `JSON.parse`-ing every line. The sidebar collapses the Archived group by default,
  so on a live-scale project most of that I/O produced rings that were never
  rendered: of 234 chats and 495 MB of transcript, **182 chats and 349 MB (71%)
  were archived**. The endpoint is called on every project open and after every
  completed turn, per open tab.

  The endpoint is now scoped: `?scope=active` (the new default) / `archived` /
  `all`. The client asks for the archived half only once that group is actually
  expanded. The lazy fetch keys off the group's **expanded state**, not the
  disclosure button, because three separate things open it — the user toggling it,
  archiving a chat, and deep-linking into an archived chat — and the failure mode
  here is invisible (a ring that silently never appears). A turn completing
  refreshes the archived rings only for a client that has already asked for them.

  Also raises `MTIME_CACHE_MAX` (the sub-agent transcript memo) from 64 to 1024.
  That corpus holds 514 transcript files for 234 chats, so at 64 a single sweep
  evicted every entry before the next sweep could reuse one and the cache was pure
  overhead. The entries are token tallies, not transcript text: pushing all 1,515
  sessions in the corpus through both cached paths and then forcing GC retained
  1.4 MB at the new cap versus 1.3 MB at the old one.

  Measured on that corpus (v0.51.0 build vs. this one, same data, interleaved):
  project open 4.18 s → **1.23 s** cold and 0.40–0.54 s → **0.014–0.021 s** warm.
  Expanding Archived costs 3.05 s once, then 0.020 s. The two changes are not
  redundant: scoping alone takes the warm call to 0.047–0.095 s and is the only
  thing that moves cold; the cache cap takes it the rest of the way, and is worth
  15× on its own for a same-scope call (0.44 s → 0.029 s at `scope=all`).
  Behaviour is unchanged:
  `active ∪ archived` is exactly the old response — same 234 keys, zero differing
  fields — and the 234 rendered rings are byte-identical, in the same order,
  between the two builds.

- [#547](https://github.com/edspencer/paddock/pull/547) [`0c62cf3`](https://github.com/edspencer/paddock/commit/0c62cf39e8f5a56c85e3999e9c50255bde6dfae1) Thanks [@edspencer](https://github.com/edspencer)! - Replace the last three native browser dialogs with Paddock's own modals (#541).
  Renaming a chat popped a `window.prompt()`, and reverting a chat / deleting a
  trigger popped `window.confirm()` — grey, unthemed browser chrome sitting one
  button away from Fork Chat's styled dialog, prefixed with `"<host> says"` in the
  installed PWA, and blocking the main thread (including the live transcript)
  until dismissed.

  The revert dialog is the one that gains more than polish. Its warning — that
  tool calls after the revert point are **not** undone, only the conversation is —
  was being assembled into a single `\n\n`-delimited string, so the most important
  sentence in the most destructive of the three actions arrived as undifferentiated
  plain text. It is now structured content: the message and tool-call counts are
  emphasised, and the "those actions are not undone" caveat is its own callout
  instead of a clause buried mid-paragraph.

  Two behaviours are deliberately preserved rather than reimplemented. Clearing
  the rename field still **resets** a chat to its generated preview name — that was
  `prompt()`'s `""`-vs-`null` return doing double duty, and a dialog that only
  reported "closed" vs "submitted" would have quietly dropped it; the modal now
  advertises it (the hint names the fallback and the button relabels to "Reset
  name"), where the prompt could only be discovered by accident. And the revert
  dialog opts out of backdrop-click dismissal, since it carries warning text meant
  to be read and silently discarding that decision on a stray click is worse than
  requiring a button.

  Also: `ConfirmDialog` gains `wide` and `dismissOnBackdrop`, the Escape-to-close
  listener the modals each had their own copy of is now one `useEscapeKey` hook,
  and the two re-thrown failures (revert, trigger delete) now surface inside the
  dialog and leave it open to retry rather than closing onto a banner elsewhere.
  A source-scanning test keeps the ban enforced rather than documented.

## 0.51.0

### Minor Changes

- [#533](https://github.com/edspencer/paddock/pull/533) [`407a70e`](https://github.com/edspencer/paddock/commit/407a70e1f6fd2f5aa24b9a8a38933957899d188b) Thanks [@edspencer](https://github.com/edspencer)! - The root is a workspace, not a project with a magic slug

  Replaces the `__root` sentinel with a **workspace** model keyed by the path
  relative to `projectsRoot`. The root workspace's key is the empty string — the
  zero value already in the key space, not a reserved name — so `path.join(root,
"")` resolves it and the resolution seam stops branching. Both copies of
  `dirFor` are now the same one-liner, which makes the class of bug that shipped in
  v0.49 (one copy missing the branch, 404ing every root file route) structurally
  impossible.

  **The root workspace always exists.** No `project.yaml` gate, no creation
  endpoint, no enable card, and no `Project not found: __root` when you click New
  chat on a fresh instance. `GET`/`POST /api/root-project` are gone; the root's
  defaults are derived (its name is the projects-root directory basename) and a
  record is written lazily, only when a setting actually changes.

  **Workspace-scoped routes are now mounted twice** — `/api/root` (key `""`) and
  `/api/projects/:slug` — from a single Fastify plugin. Same handlers, same
  schemas, same error paths, so "the root behaves like a project" holds by
  construction rather than by discipline.

  `/` is the root workspace's Home, and the projects grid is its children tab at
  `/projects`.

  Also fixes three latent bugs the empty key exposed, all the same falsy-vs-absent
  mistake: a chat whose parent was a root chat had its recorded parent edge
  discarded (falling through to the inference tier and rendering as an orphan);
  root chats were skipped by the recovery nudge, silently disabling Continue and
  auto-re-drive; and root chats were dropped from the per-workspace unread badge.

## 0.50.1

## 0.50.0

### Minor Changes

- [#524](https://github.com/edspencer/paddock/pull/524) [`ae9ef1c`](https://github.com/edspencer/paddock/commit/ae9ef1c5d93d41c9f895d331df5fd0b9a38fa01f) Thanks [@edspencer](https://github.com/edspencer)! - feat: retire scratch — one-off chats are root chats now (#516 Phase 6).

  No migration ships with this. The companion PR that re-homed existing scratch
  transcripts onto the root keeper was dropped deliberately: it was a permanent
  boot-time migration carrying a one-time, few-hundred-kilobyte data move for an
  instance count in the single digits. Existing scratch transcripts stay on disk
  at `<scratchDir>/.chats` and simply stop being listed. Nothing reads them.

  Scratch existed because a chat had to belong to _some_ agent and there was no
  agent for "the instance itself". #516 gave the instance's root a project and an
  ordinary keeper, which makes scratch redundant — and strictly worse, since it was
  deliberately denied self-MCP, curation, triggers, attachments, run history, the
  `<projectsRoot>/CLAUDE.md` walk-up, and more than one turn at a time. Every one
  of those a root chat gets for free.

  **Removed**

  - The mirrored scratch route cluster (11 routes under `/api/chats/…`) and
    `GET /api/commands`.
  - The `scratch` agent itself: `buildScratchConfig`, `ensureScratchModel`,
    `listScratchSessions`, `herdctl.scratchDir`, `SCRATCH_AGENT`, `SCRATCH_SLUG`.
  - The ~14 `slug === SCRATCH_SLUG` guards across `route-context`, `ws`,
    `ws-turn`, `ws-triggers`, `wake-injection` and `spawn-capability`. Several were
    the _only_ reason a code path had two branches.
  - `OneOffChat.tsx`, the projects grid's Inbox section, and the scratch half of
    the web API client.

  **Changed**

  - **`promote` is generalised, not deleted.** `promoteScratchSession(id, project)`
    becomes `promoteSession(id, from, to)`, and
    `POST /api/chats/:sessionId/promote` becomes
    `POST /api/projects/:slug/chats/:sessionId/promote`. The operation was never
    really about scratch — it moves one chat from one keeper's store to another's —
    and the root is a project, so the chats that inherited scratch's URL inherit
    its promote action. The UI offers it on root chats; the server route is
    generic. New failure mode, pinned by a test: an unknown _source_ project 404s
    and creates nothing.
  - **`/chat` is unconditionally a root chat.** It used to fall back to a one-off
    without a root project; it now 404s there, joining `/files`, `/changes`,
    `/history` and `/triggers`. Nothing links to it without a root project — the
    sidebar's chat CTA is hidden in that state.

  **Kept on purpose:** `PADDOCK_SCRATCH_DIR` / `cfg.scratchDir`. Nothing runs or
  reads there any more, but the setting is left in place so an existing env or
  config file does not fail validation, and so the old transcripts remain findable
  by hand. Documented as legacy in `CONFIGURATION.md` and relabelled in instance
  settings.

  **Breaking:** every `/api/chats/*` endpoint is gone, as is
  `GET /api/commands`. An external client using the one-off API should move to
  `/api/projects/__root/chats/*`.

## 0.49.0

### Minor Changes

- [#517](https://github.com/edspencer/paddock/pull/517) [`e50f54c`](https://github.com/edspencer/paddock/commit/e50f54c5763365a1de5e96bb1e01f0893d225a6a) Thanks [@edspencer](https://github.com/edspencer)! - feat: the root is a project — root Home and root chats (#516, Phases 1–3).

  A Paddock instance can now be as capable at its root as inside any project. The
  framing: **the root is the project whose directory is `projectsRoot` instead of
  a subdirectory of it.** Its keeper is an ordinary keeper — same
  `buildKeeperConfig`, same self-MCP, same `max_concurrent: 10`, same chat tree,
  same per-chat model, same sweeper. Nothing is special-cased; one assumption
  about where a project directory sits is relaxed.

  `ProjectStore.dirFor()` is the single resolution seam: the reserved `__root`
  slug maps to the projects root itself, so read/update/overview/changelog/file
  serving all work on it unchanged. `list()` is untouched — it only walks
  subdirectories, so the root stays out of enumeration and is resolved explicitly
  at boot. New `GET`/`POST /api/root-project` ask whether an instance has one and
  create it; everything else goes through the ordinary `/api/projects/__root/…`.

  In the web, `urls.ts` generalises `slug` → `base` (`""` at the root,
  `/projects/:slug` otherwise), so one `ProjectView` serves both. Root URLs are
  flat and top-level: `/` is root Home and `/chat[/:sessionId]` its chats, with
  the projects grid moving to `/projects`. `/` always renders Home — no redirect
  and no sticky last tab, so the instance's front door never lands on Files.

  **Migration is gated on existence, so nothing changes for an existing
  instance.** Nothing seeds `<projectsRoot>/project.yaml`; without it there is no
  root project, `/` is the projects grid and `/chat` is a scratch chat exactly as
  before. Creating the root project — an "Enable" card on the grid — is the whole
  opt-in.

  Worth being blunt about the escalation it buys: the root keeper's working
  directory CONTAINS every project, so root chats can read and edit any project's
  files. That is the intent — the root is where you act across the instance — but
  it is a real step up from a project keeper, which is confined to its own
  subtree.

  Files, Changes, History, Settings and retiring scratch are follow-up phases;
  their tabs are hidden at the root rather than pointed at URLs that don't
  resolve. Note that once a root project exists, `/chat` is a root chat, so
  existing scratch chats are not reachable in the UI until that final phase
  re-homes them — their transcripts are untouched on disk.

- [#521](https://github.com/edspencer/paddock/pull/521) [`29ea303`](https://github.com/edspencer/paddock/commit/29ea30313758a6079c3513443c9a532b930d3553) Thanks [@edspencer](https://github.com/edspencer)! - feat: History, Settings and Triggers at the root (#516 Phase 5).

  The root project now has the full tab bar — there is no tab a project gets and
  the root doesn't. History and Triggers needed only routes and un-hidden tabs:
  `/api/projects/:slug/runs` and `…/triggers` already resolved through
  `projects.get()`, so they worked for `__root` the moment it resolved.

  Settings is the one real merge. `InstanceSettings`' editor body is extracted
  verbatim into a shared `InstanceConfigForm`, so:

  - `/settings` **without** a root project is the standalone admin page, unchanged.
  - `/settings` **with** one resolves to the root's Settings tab, showing the
    root's own workspace config (`project.yaml`, hot-applied) above the instance
    runtime config (`paddock.config.yaml`, frozen at boot, restart-required).

  They stay two sections rather than being fused, because those lifecycles really
  are different and fusing them would hide that.

  The root's overflow menu returns with Edit but **without** Delete — `remove()`
  refuses the root (its directory IS the projects root), so offering the action
  could only ever produce an error. `ProjectMenu.onDelete` is now optional.

## 0.48.1

### Patch Changes

- [#504](https://github.com/edspencer/paddock/pull/504) [`ff1fab6`](https://github.com/edspencer/paddock/commit/ff1fab6b096047d55ac0e6aaa3e8b76c898480c4) Thanks [@edspencer](https://github.com/edspencer)! - Fix a nested chat list (#485) defect where a keeper reporting back could
  re-parent the chat it reported to. The chat-list parent edge fell through to its
  inference tier for any chat with no recorded parent — including chats whose
  provenance already marks them as roots — so on the documented report-back
  workflow (human starts a manager, manager spawns a child, child `send_message`s
  home) the manager adopted its own child as its parent. Both edges then pointed at
  each other and the tree builder's cycle guard picked a winner per render, so the
  manager flipped between top-level and nested under its own child. Inference is
  now skipped for a recorded root, and the "only the first injection marker counts"
  rule is applied positionally as its documentation already claimed.

  Also fixes two sidebar counts that read `.length` off a roots-only array while
  their denominators stayed flat chat counts: the search badge (which read `1/40`
  for a search matching five chats under one parent) and the Archived badge (which
  undercounted nested archived chats).

## 0.48.0

### Patch Changes

- [#494](https://github.com/edspencer/paddock/pull/494) [`98a8546`](https://github.com/edspencer/paddock/commit/98a854645ccab8ed29d226ad72f044c6ce4cdc2b) Thanks [@edspencer](https://github.com/edspencer)! - fix(unread): make read-state server-authoritative so devices stop diverging (#488).

  The same account could report different unread counts on different devices (observed
  live: `herdctl 2 / paddock 36` on one, `herdctl 13 / paddock 61` on another). Read-state
  is stored server-side per user, but the client layered a **persistent localStorage
  mirror** on top and took `max(server, local)` — so a local value the server never
  received marked a chat read on that device only, and the mirror never synced upward.

  Remove the persistence, keep the optimism:

  - `readLastSeen` now reads only the in-memory cache the server payload folds into —
    no localStorage, no `max()`. Opening a chat still clears its cue instantly via
    `markSeenLocally`, but that bump is session-scoped, so every reload re-derives from
    the server and divergence is structurally impossible rather than merely repaired.
  - A failed `/seen` POST now rolls the optimistic bump back (`revertSeenLocally`)
    instead of being swallowed, so the cue reappears honestly rather than sticking.
  - Dropped the cross-tab `storage` listener (it only worked via localStorage); another
    tab's mark-seen arrives with the next refetch.
  - One-time migration pushes any pre-existing localStorage read-state up to the server
    (resolving each chat's project from the `chatTurns` payload, since legacy keys carry
    only a session id), then purges the legacy keys — so removing the mirror doesn't
    resurface chats the user already read. Safe because the server store is monotonic.

  Also fixes a latent bug this exposed: `useUnreadChats` folded the server's `lastSeen`
  into a module-level cache from an effect, but the unread derivation had no dependency
  on that fold and so never recomputed. It was masked while localStorage was read
  synchronously during render; without it, a freshly-loaded chat could show an unread
  cue the server already knew was seen.

## 0.47.0

### Minor Changes

- [#485](https://github.com/edspencer/paddock/pull/485) [`4988501`](https://github.com/edspencer/paddock/commit/4988501702cca9840b4c5d9af09e34aed5f6dbab) Thanks [@edspencer](https://github.com/edspencer)! - feat(chat-list): nest chats under the chat that created them.

  The sidebar was flat, so a keeper fanning out a dozen children via `create_chat`
  produced a dozen unrelated-looking rows. Provenance (#267) recorded that a chat
  was `spawned` and how deep, but never _by whom_ — the list could badge a child
  yet not file it under its parent. Now it can.

  - **Server:** `RunProvenance` gains `parentSessionId`/`parentProject`, recorded at
    creation. `fork_chat` stamps its _source_ as the parent, and the UI fork route —
    which previously stamped no provenance at all, leaving hand-forked chats
    indistinguishable from human roots — stamps it too. Chats created before the
    field existed backfill from `MessageProvenanceStore`: a spawned chat's kickoff
    prompt was injected _by_ its parent, so the first `chat`-kind sender marker is
    the parent. Both are in-memory sidecars, so the resolver is cheap enough to run
    per row. The edge surfaces on the chat DTO as `parent`.
  - **Web:** `buildChatTree`/`flattenTree` turn the flat list into a forest, with a
    twisty, guide lines, and a count pill on collapsed parents. Three flat-list
    behaviours don't survive nesting unchanged: subtrees now sort by their _newest
    descendant_ (mtime-desc alone strands a parent below its own fresh children),
    starring floats within a sibling group rather than globally (which would tear a
    starred child out from under its parent), and search keeps a match's ancestors
    and overrides collapse (else a folded-up parent hides the very chat you searched
    for). A parent outside the visible set — cross-project, archived, filtered —
    renders as a root rather than swallowing its children.

  Chats start expanded: nesting only re-orders and indents rows already in the list,
  so collapsing by default would hide chats that are visible today. Collapse state
  persists per project, per browser.

## 0.46.0

### Minor Changes

- [#469](https://github.com/edspencer/paddock/pull/469) [`423d1fb`](https://github.com/edspencer/paddock/commit/423d1fba7d2c9c632fab17b3aeccaf44e91f5d2d) Thanks [@edspencer](https://github.com/edspencer)! - Self-management MCP: add `create_project` so a keeper can provision a project (#467)

  Keepers could create chats inside an existing project but never the project itself,
  so agent-driven setup always stopped to ask a human to click **New project** (and an
  on-box `curl` to `POST /api/projects` has no credential on a JWT instance).

  `create_project` takes `name` (required) plus optional `slug`, `repo`, `summary`,
  `area` and `status`, and returns the new slug, working dir and whether it is
  repo-backed. Passing a `repo` git URL creates a repo-backed project — cloned into a
  nested checkout that becomes the keeper's cwd, with the existing rollback-on-clone-
  failure behaviour, so a bad URL leaves no half-made project behind. Under the hood it
  calls the same `ProjectStore.create` + `ensureProjectAgent` pair `POST /api/projects`
  does, so the REST and MCP paths can't drift.

  Gated behind a new instance flag `selfMcpProjectsEnabled` / `PADDOCK_SELF_MCP_PROJECTS`
  (default OFF, only honoured when the self-MCP write tools are also on). It gets its own
  switch rather than riding on `selfMcpWriteEnabled` because — unlike every other write
  tool — it creates instance-level state and clones a caller-supplied git URL. Existing
  deployments see no change to their tool surface.

- [#472](https://github.com/edspencer/paddock/pull/472) [`c0e0436`](https://github.com/edspencer/paddock/commit/c0e0436d8233a612104b627ee632abd33163dd6b) Thanks [@edspencer](https://github.com/edspencer)! - feat(management-api): mount the streamable-HTTP MCP transport at `/mcp` (#312 M2).

  Stacked on the M1 policy layer. An external MCP client — a laptop Claude Code
  session, or eventually a peer Paddock — can now drive the management operations
  over HTTP, bounded by the scope its credential carries.

  The toolset is **not** redefined for external callers: the same
  `InjectedMcpServerDef` a keeper receives in-process is adapted onto the MCP SDK,
  so adding a self-MCP tool exposes it over `/mcp` with no further work, and a
  client's toolset upgrades when the server does.

  - **Transport:** `@modelcontextprotocol/sdk@1.29.0` (protocol revision
    `2025-11-25`), `WebStandardStreamableHTTPServerTransport`, **stateless** — a
    fresh server and transport per request, so there is no session store, restarts
    are transparent, and one principal's tool visibility cannot leak into another's
    session. Implemented against the low-level `Server` so the existing
    hand-written JSON Schemas pass through verbatim rather than round-tripping
    through Zod.
  - **Scope shapes the wire.** A read-only client is _offered_ only read verbs, and
    a call to a verb it wasn't offered is refused rather than executed. Project
    scoping keeps the M1 split: enumerations filter, explicitly-addressed targets
    are denied.
  - **`GET`/`DELETE` answer `405`.** In stateless mode a `GET` would open an SSE
    stream that never emits, leaving the client waiting on a header-less socket.
  - **Response headers are flushed before the body.** Node buffers `writeHead()`
    until the first byte, so a slow tool call — and every turn-spawning operation
    is one — would otherwise stall the _headers_ for its whole duration and read as
    a hang to any proxy with a response-header timeout.
  - **RFC 9728 discovery** at the path-inserted
    `/.well-known/oauth-protected-resource/mcp` (plus the root form), served
    unauthenticated with permissive CORS — a client fetches it before holding any
    credential. Published **only when `managementApi.authorizationServers` is
    configured**: the MCP spec makes `authorization_servers` mandatory, and a
    token-only deployment has none, so it publishes nothing rather than a document
    that sends clients hunting for an authorization server that doesn't exist.
  - **OAuth scopes** (`paddock:read` / `paddock:write`) are a coarse projection of
    the fine-grained operation lists, used only in challenges and discovery —
    because those are read by humans on a consent screen. Authorization is still
    decided on the operation list.

- [#471](https://github.com/edspencer/paddock/pull/471) [`a37a8e5`](https://github.com/edspencer/paddock/commit/a37a8e53daefa32637b20844a77209d5d89f83a6) Thanks [@edspencer](https://github.com/edspencer)! - feat(management-api): policy layer + config-token authentication for external callers (#312 M1).

  The first half of Phase 3 of the self-management MCP epic (#214): everything an
  external caller needs _except_ the MCP transport itself, which lands in M2. The
  `/mcp` endpoint exists and authenticates, but answers `501` until the transport
  is mounted.

  Management-API auth is **entirely self-contained** — independent of
  `PADDOCK_AUTH_MODE` and of any reverse proxy. Paddock authenticates `/mcp`
  itself, so it stays credential-gated even at `auth.mode: none`, and a proxy is
  never a prerequisite for running Paddock.

  - **Ops layer split out of the MCP transport.** `buildSelfMcpServerDef` used to
    build the operation callbacks _and_ assemble the MCP server def in one
    function, so a non-MCP caller couldn't reach the operations.
    `buildManagementOps` now constructs them alone; `ws-self-mcp.ts` is reduced to
    transport assembly. `makeChatHandler` additionally returns the shared ops
    context, threaded through `app.ts` into the route layer beside the existing
    `fireTrigger`.
  - **Policy is enforced at the ops layer, not per-transport.** Every operation is
    checked against a `ManagementPrincipal` centrally, so the REST parity work in
    #465 inherits identical auth + scope rather than reimplementing it and
    drifting. Enumerating operations filter to the permitted projects; operations
    naming a target assert, and raise a denial the transport maps to `403` +
    `WWW-Authenticate: … error="insufficient_scope"`. The in-process keeper path
    runs under a full-trust internal principal (it is bounded by depth, not scope)
    and bypasses the wrapper, so keeper behaviour is unchanged.
  - **Read-only by default.** Any write scope is effectively remote code execution
    on the host — `create_chat` / `send_message` / `fork_chat*` / `run_trigger`
    start keeper turns, and a keeper has `Bash` — so a client configured without an
    explicit scope gets the risk class that cannot execute code, and a scope that
    does grant it is called out loudly at boot.
  - **Config tokens are referenced, never inlined.** `auth: { ref: "env:VAR" }`;
    an inline secret in the git-tracked config file is a hard error. A credential
    that won't resolve (unset, or below the length floor) drops _that client_ and
    leaves the rest working. Comparison is constant-time over fixed-width digests,
    and a `pdk_<instanceId>_…` token is rejected unless the instance matches, so a
    credential minted for one Paddock is meaningless at another.
  - **`managementApi.publicUrl` is required** once clients are configured — RFC
    9728 requires the metadata document's `resource` to byte-match the URL the
    client used, and that can't be derived from an attacker-controlled `Host`
    header. Plaintext is refused for non-loopback hosts, since `/mcp` carries
    bearer tokens.
  - **Fail closed.** `/mcp` 404s unless clients _and_ a public URL are configured;
    a missing or bad credential is `401` + `WWW-Authenticate`, never a `302` to a
    login page (which no MCP client can follow, and which breaks OAuth discovery).
  - **`/.well-known/` and `/mcp` are excluded from the SPA catch-all.** Both are
    extension-less, so the not-found handler previously answered them with the app
    shell and a `200`. That holed the fail-closed guarantee and broke MCP OAuth
    discovery: a client fetching the protected-resource metadata received HTML,
    failed to parse it, and silently fell back to treating Paddock as its own
    authorization server with no error naming the cause.

- [#463](https://github.com/edspencer/paddock/pull/463) [`fd7d6b4`](https://github.com/edspencer/paddock/commit/fd7d6b4973f8d463fe1eb3ce3e997a743c274551) Thanks [@edspencer](https://github.com/edspencer)! - feat(chats): add a sixth chat action to mark a conversation unread (#458).

  A new hover action on each chat row toggles the chat's read/unread state — the
  email-client pattern for "I glanced at this late at night, resurface it in the
  morning". Marking a read chat unread re-raises its accent-dot cue; marking an
  unread chat read is equivalent to the existing mark-seen flow.

  - **Server:** a new per-user `UnreadStore` sidecar (`unread-state.json`) holding a
    manual "unread" override, layered on top of the derived read-state. It's keyed
    by user like read-state (not shared like star/archive), since "I haven't dealt
    with this yet" is personal. New `POST .../chats/:id/unread` routes (project +
    scratch); the existing `/seen` routes now also clear the override, so opening or
    focusing a chat spends the flag. The flag surfaces on the chat DTO as `unread`.
  - **Web:** a `toggleUnread` handler (optimistic with rollback, mirroring
    archive/star), a sixth envelope button in the session sidebar, and the unread
    derivation now folds in the manual override. The `useUnreadChats` hook clears
    the override whenever a chat is marked seen so the cue can't flicker back.

- [#464](https://github.com/edspencer/paddock/pull/464) [`31f84e9`](https://github.com/edspencer/paddock/commit/31f84e961d80b8b3529d2fe8f55ebb6da079dac3) Thanks [@edspencer](https://github.com/edspencer)! - feat(chat): per-message hover — context usage + timestamp, Fork-from-here & Revert-to-here

  Hovering a message in the transcript now reveals a small rail at its top-right
  showing **when** that message happened and **how full the context window was** at
  that point, plus two actions: **Fork a new chat from here** and **Revert
  conversation back to here**. On a long chat this answers "is this from minutes or
  days ago?" and "where did the context actually fill up?", and lets you branch off
  or roll back from any earlier point.

  - **Per-message context + timestamp.** Each assistant turn's `usage` already
    equals the context-window fill at that moment (`input + cache_read +
cache_creation`), so this is a point-in-time read, not a cumulative sum. A new
    mtime-cached `readContextSeries` pass maps each transcript record `uuid` to its
    fill; the messages endpoint forward-fills it across the turns between, so every
    message can answer "how full was the window as of here". The chat-LIST path is
    deliberately untouched — this runs only when a chat is open, so the sidebar
    stays lean.
  - **Fork from here.** `forkSession` gains an optional cut point: the new chat
    copies only the transcript PREFIX up to the chosen message (tool_use/tool_result
    pairing preserved) instead of the whole history. The source is untouched. Both
    the HTTP route and the `fork_chat` MCP tool inherit it.
  - **Revert to here.** New `revertSession` truncates the chat in place, keeping its
    session id (so the URL and lineage survive) and backing the dropped tail up to a
    `.reverts/` sidecar. Reverting to one of your OWN messages rewinds to the
    assistant's previous reply rather than leaving a dangling un-answered prompt —
    otherwise resume replays it as a phantom turn and the model reads your
    instruction as stale backlog.
  - **Revert warns about side-effects.** The confirm dialog counts the messages and
    tool calls that will be removed and states plainly that those actions (files
    written, PRs opened, messages sent) are **not** undone — only the conversation.
  - The rail is keyboard-accessible (`focus-within` reveal + focus rings), anchors
    on the record `uuid`, and appears only on reloaded user/assistant turns — never
    on tool cards, notices, or live-streaming turns.

## 0.45.0

### Minor Changes

- [#462](https://github.com/edspencer/paddock/pull/462) [`603b392`](https://github.com/edspencer/paddock/commit/603b392c4a289a54ed26801e8bf9ca02567260f9) Thanks [@edspencer](https://github.com/edspencer)! - feat(models): make the offered model list configurable per instance + per project

  The built-in `MODELS` catalog stays the authoritative source of model metadata
  (label / context limit / pricing) and the `isKnownModel` validation set. What
  becomes configurable is the ALLOW-LIST of which catalog models are offered —
  operators pick from the catalog by id, so they can't misconfigure a context
  limit.

  - **Instance allow-list.** New `models` config knob — env `PADDOCK_MODELS`
    (comma-separated ids) over YAML `models:` (a string array) over the default
    (unset ⇒ every catalog model, unchanged behaviour). Unknown ids are dropped;
    an empty result collapses back to the full catalog, so an instance never
    offers zero models. Editable from the Instance Settings screen.
  - **`GET /api/models`** now returns the resolved instance allow-list and the
    EFFECTIVE keeper default (the keeper default if still offered, else the first
    offered model).
  - **Per-project override.** New per-project `models` allow-list (`project.yaml`
    - DTO + PATCH). It may only SUBSET the instance list — each id must be a known
      catalog model AND currently offered by the instance (a 400 otherwise). The
      Settings tab exposes a checkbox list; the per-project default and the per-chat
      picker are constrained to the project's subset when it sets one.
  - Backward-compatible: with nothing configured, every catalog model is offered
    exactly as before.

- [#457](https://github.com/edspencer/paddock/pull/457) [`d06133d`](https://github.com/edspencer/paddock/commit/d06133d9e19613feba8df3e52bd6b1a6225bd481) Thanks [@edspencer](https://github.com/edspencer)! - feat(models): add Claude Opus 5 and make it the default keeper model

  Opus 5 (`claude-opus-5`) shipped 2026-07-24 — same $5/$25 per-MTok pricing as
  Opus 4.8 but greatly improved performance for the same cost (stronger
  verification/iteration, fewer reasoning tokens), and Anthropic's new default on
  Claude Max, which is the tier Paddock's keeper agents run on.

  - Add `claude-opus-5` as the first entry in the model picker (1M context
    window, $5/$25 pricing) and set `KEEPER_DEFAULT_MODEL` to it, so new
    projects and un-overridden keepers use Opus 5.
  - Keep `claude-opus-4-8` selectable (non-default) for regression comparison and
    prompts tuned to 4.8's behaviour.
  - Sweeper/curator default is unchanged (`claude-haiku-4-5-20251001`).

  No config-schema change: the picker list, `/api/models`, `isKnownModel`
  validation, context meter, and cost math all read the one-file `models.ts`
  catalog, so this is a catalog + default bump only. Making the available-model
  list itself instance/project-configurable is scoped as a follow-up.

### Patch Changes

- [#452](https://github.com/edspencer/paddock/pull/452) [`de705a0`](https://github.com/edspencer/paddock/commit/de705a05e7e1fd3960612c01aecc623abf1d8a22) Thanks [@edspencer](https://github.com/edspencer)! - docs(website): link the `edspencer/paddock-deploy` recipes repo across the
  entry-point pages, complementing the existing Guides coverage.

  - **Getting started** gains a "Ready-made deploy recipes" pointer after the
    docker-compose block, linking the repo and its `docker/` subdir.
  - **Authentication** cross-links the `auth-basic/` Caddy sidecar as the turnkey
    Tier-1 gate and points at the Securing ladder.
  - **What's New** adds a 0.44 entry covering the two official images (`:latest`
    base + `:devbox`) and the new `paddock-deploy` recipes repo.
  - **Environment variables** links the deploy recipe's port-publish note to the
    `docker/` recipe.

- [#456](https://github.com/edspencer/paddock/pull/456) [`2f8e40c`](https://github.com/edspencer/paddock/commit/2f8e40ce2ce438dded74b69a7bba1e2454099f23) Thanks [@edspencer](https://github.com/edspencer)! - ci(release): also attach a stable-named `paddock-latest.tgz` (+ `.sha256`) to
  each GitHub Release, alongside the existing pinned `paddock-<version>.tgz`.

  GitHub's `releases/latest/download/<asset>` redirect only resolves when the
  asset filename is identical across every release, so the version-named tarball
  could never be fetched that way — the natural-looking
  `releases/latest/download/paddock-latest.tgz` 404'd. The release job now uploads
  an identical copy of the tarball under the fixed name `paddock-latest.tgz`, so
  that URL always points at the newest release. Self-hosters and deploy recipes
  can pick a floating (`paddock-latest.tgz`) or pinned (`paddock-<version>.tgz`)
  download. Fixes #454.

- [#460](https://github.com/edspencer/paddock/pull/460) [`b04947b`](https://github.com/edspencer/paddock/commit/b04947b030e1606a7e2b72f962687ac0ce016c05) Thanks [@edspencer](https://github.com/edspencer)! - docs(website): bring the **What's New** page up to date through v0.44.

  The page previously jumped from the 0.44 entry straight to 0.38, so five
  releases were missing and the 0.44 entry omitted the live sub-agent work. Adds
  user-facing entries for **0.39 → 0.43** and rounds out **0.44**, each with
  integrated full-page and cropped screenshots of the new UI:

  - **0.44** — live-rendering of nested background sub-agent cards (#429).
  - **0.43** — session-mode background work that survives the turn boundary and
    delivers its result live on completion (#430).
  - **0.42** — the instance-wide Settings screen (#385), per-project curation
    budgets (#384), and pinning any file as a tab at any depth (#388).
  - **0.41** — star/pin chats (#373), draggable & persisted pane widths (#374),
    the one-row mobile header (#372), and the full-file sweeper with per-file
    token budgets (#379).
  - **0.40** — promote a notebook project to repo-backed in place (#213) and keep
    the dictation mic usable while the keeper is replying (#365).
  - **0.39** — surface turn errors & usage-limit hits as inline notices (#329),
    Run-now + live run-status in the Triggers tab (#327), spawned-chat model
    selection (#336), and client-local slash-command rendering (#158).

  New screenshots under `website/src/assets/whats-new/`: `instance-settings.png`,
  `curation-budgets.png`, `pinned-file-tabs.png`, `starred-chats.png`,
  `turn-notice.png`.

## 0.44.0

### Minor Changes

- [#436](https://github.com/edspencer/paddock/pull/436) [`52f25aa`](https://github.com/edspencer/paddock/commit/52f25aa56bda7997e6f79778038e651230cf7d95) Thanks [@edspencer](https://github.com/edspencer)! - Background sub-agent cards now render live, without a refresh.

  Building on the background-work delivery in the previous release, a `Task`/`Agent` sub-agent's card is now enriched the instant it launches — instead of showing a generic launch acknowledgement until the chat is reloaded.

  - **Real type + title, live.** The sub-agent's type (e.g. `general-purpose`) and description are recovered from the tool call's input as it streams and shown on the card immediately.
  - **Running state.** A still-working sub-agent shows a running spinner in place of its near-instant launch time — including a background sub-agent whose launch call has already returned but whose own run continues.
  - **Streaming inner steps.** Expanding a running sub-agent now streams its nested steps as they happen (polled from the growing sub-agent transcript), recursing into nested sub-agent launches at any depth.
  - Enrichment is applied across every turn path (interactive chat, scheduled wake, and slash-command turns), and the reload view is unchanged.
  - **Sub-agent card cost is now the recursive total** of the sub-agent plus everything it spawned (cost only; durations stay per-agent because nested work runs in parallel).

  Known cosmetic limitations, tracked as follow-ups: a nested (depth 2+) launch shows a generic label until it completes; a running sub-agent's duration and cost appear once it settles or on reload; and reloading while a background sub-agent is still running shows a partial duration rather than the running state.

### Patch Changes

- [#445](https://github.com/edspencer/paddock/pull/445) [`9b45121`](https://github.com/edspencer/paddock/commit/9b45121f19eb8380de7cc4cf8f0a10a89e004cf5) Thanks [@edspencer](https://github.com/edspencer)! - docs(website): add "The Dev Box flavor" guide

  New Guides page explaining the `devbox` image — what it adds over `base` (the `pm`
  preview-server wrapper, `ffmpeg`, the headless Playwright MCP browser with
  `PADDOCK_BROWSER_MCP=1` on by default, and the Docker CLI), how to run it, using
  `pm`, and the docker-in-docker trade-offs — cross-linked to the `docker/` recipe
  in `paddock-deploy`.

- [#433](https://github.com/edspencer/paddock/pull/433) [`4da36de`](https://github.com/edspencer/paddock/commit/4da36de1ecaf9a94c8bc8400a710454f91fb779c) Thanks [@edspencer](https://github.com/edspencer)! - Fix the Paddock MCP tool badge showing the wrong project. The brand badge on a `paddock_manage` tool card (e.g. `create_chat`) was a hardcoded "Paddock" label that CSS-uppercased to "PADDOCK", so a cross-project action — a keeper in project A creating a chat in project B — mislabelled the badge with the brand name instead of the target project, contradicting the card body's own "in {project}" line and open-chat link. The badge now reads the tool result's target `project` when the action carries one (create/fork/read/send/list-in-another-project), falling back to the "Paddock" brand label for project-less actions (`list_projects`, `fork_chat_batch`). Badge and body now agree.

- [#442](https://github.com/edspencer/paddock/pull/442) [`546e32c`](https://github.com/edspencer/paddock/commit/546e32ce126b2282de389d8073067525c8b6cf80) Thanks [@edspencer](https://github.com/edspencer)! - feat: split the Docker image into `base` + `devbox` targets

  The Dockerfile now builds two images from shared stages. `base` (`--target
base`) is the lean runtime published as `:<version>` / `:latest` — the app plus
  `git`, `gh` and the `claude` CLI. `devbox` (`--target devbox`) layers the
  coding-agent toolbox on top — PM2 + the vendored `pm` preview-server wrapper,
  `ffmpeg`, the Playwright MCP browser (headless Chromium) and the Docker CLI —
  and is published as `:<version>-devbox` / `:devbox` (with `PADDOCK_BROWSER_MCP=1`
  so browser tools attach out of the box). The release workflow now builds each
  target per-arch on native runners and merges one manifest per target.

- [#437](https://github.com/edspencer/paddock/pull/437) [`fb08a29`](https://github.com/edspencer/paddock/commit/fb08a29284f9e15e56ec4a01d7f7af7a567a44bc) Thanks [@edspencer](https://github.com/edspencer)! - chore: vendor scripts/pm preview-server wrapper

  Vendor the `pm` CLI (a PM2 + shared-ports-registry wrapper for stable-port
  preview servers) into the repo at `scripts/pm`, so it's MIT-licensed here and
  the devbox image can bundle one canonical copy. Documented in `scripts/README.md`.

- [#447](https://github.com/edspencer/paddock/pull/447) [`a919421`](https://github.com/edspencer/paddock/commit/a919421edf7608321a99ab03ba8bd95816104718) Thanks [@edspencer](https://github.com/edspencer)! - docs(website): wire the new deploy guides into the sidebar and thread the images +
  `paddock-deploy` recipes through the existing docs.

  - Add **The Dev Box flavor**, **Running Paddock on Proxmox (LXC)**, and **Running
    Paddock on Kubernetes** to the Guides sidebar group.
  - **Getting started** now explains the `:latest` (base) vs `:devbox` image tags.
  - **Deploying Paddock** points at the `edspencer/paddock-deploy` recipes (`docker/`,
    `proxmox-iac/`, `kubernetes/`, `auth-basic/`).
  - **A home-lab setup** notes the devbox image as the modern, pre-composed path and
    cross-links `paddock-deploy`, keeping the as-code narrative intact.

## 0.43.0

## 0.42.5

### Patch Changes

- [#426](https://github.com/edspencer/paddock/pull/426) [`03ba351`](https://github.com/edspencer/paddock/commit/03ba351667e55c0e7d326517f8b57c719ddbd5e1) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `ChatPane.tsx` (~2900 lines — the largest file in the repo) into focused sibling modules under `components/chat/`, leaving the container (composer JSX, send/cancel/continue paths, history hydration, model-picker + queued-message effects) cohesive at ~1070 lines. Behavior is identical — same transcript, streaming turn lifecycle, tool rendering, composer, and recovery affordances. Extracts the pure tool helpers + constants into `chat/toolFormatting.ts`; the `Turn` union, the single `nextId` counter, the transcript reducers, and `historyToTurn`/`historyToTurns` into `chat/turnModel.ts` (`historyToTurns` is re-exported from `ChatPane` so importers resolve unchanged); the three React contexts + `RecoveryContextValue` into `chat/chatContexts.ts`; the props-only composer widgets (`PreloadToggle`/`StatusRow`/`ContextMeter`/`SessionCost`/`WorkingIndicator`/`QueuedMessageBar`/`ConnDot`) into `chat/ComposerBits.tsx`; the whole transcript render cluster (`TurnView`/`ToolBlock` + bodies/`NestedSteps`/`SenderAttribution`/`CompactBoundary`/`KilledTaskNotice`/`NoticeBlock`) into `chat/Transcript.tsx` (kept in one file for the `TurnView → ToolBlock → NestedSteps → TurnView` cycle); the WS subscription effect + its ~12 frame handlers into `chat/useChatSocket.ts` (the ~13 refs stay owned by `ChatPane` and are threaded through a params object, so the effect body + dependency array are unchanged); and the composer attachments state + paste/drag/drop/pick handlers into `chat/useComposerAttachments.ts`. `ChatPane` remains the sole component export; no importer changes. Completes the last file in #403.

- [#425](https://github.com/edspencer/paddock/pull/425) [`9157311`](https://github.com/edspencer/paddock/commit/9157311ce4d82fa6335b27931a934b429037c9db) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `ProjectView.tsx` (~1700 lines) React route into focused sibling modules under `routes/ProjectView/`, leaving the route shell (URL-derived tab/chat/file state, data fetching, chat lifecycle side-effects, and the establish/sweep-race guards) cohesive at ~1000 lines. Behavior is identical — same routes, tabs, sidebar, and unread/running semantics. Extracts the pure URL helpers + `deriveView`/`ProjectViewTab` into `urls.ts`; the props-only `TabButton`, `PinnedTab`, and the inlined Home tab (`HomePane` + `Meta`) into their own files; the session-list column (`chatRow` + sidebar JSX) into `SessionSidebar.tsx` (drilled via one props object; the WS subscription and `runningSessions` stay owned by `ProjectView` so the fleet-wide running set doesn't fragment); and the unread affordance (`markSeen`, the server-lastSeen fold, the `unread` memo, and the running-set transition effects, owning `liveUnread`/`seenVersion`) into the `useUnreadChats` hook. `ProjectView` remains the sole export; no importer changes. Part of #403.

## 0.42.4

## 0.42.3

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

### Patch Changes

- [#388](https://github.com/edspencer/paddock/pull/388) [`6c6f538`](https://github.com/edspencer/paddock/commit/6c6f53897ca880ce5e41303eb61f66419deff059) Thanks [@edspencer](https://github.com/edspencer)! - Allow pinning files at any depth as sibling tabs, not just top-level ones. The
  "Pin as tab" affordance was gated to project-root files by two UI conditions in
  the Files browser (`isTopLevel` in the file viewer and `path === ""` in the
  directory listing), even though every layer beneath it already handled nested
  project-relative paths — `pinFile`/`readFile`'s traversal guard, the pin REST
  routes, the `pinned: string[]` model, files-subpath URL deep-linking, and the
  sticky-tab persistence.

  Both gates are lifted, so any file reachable through the Files page can be
  pinned from its list row or its viewer; the pin stores the full
  project-relative path (e.g. `design/plan.md`). A nested pinned tab shows its
  basename as the visible label to stay compact, with the full path in its
  `title`/`aria-label`.

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

- [#375](https://github.com/edspencer/paddock/pull/375) [`331e2ee`](https://github.com/edspencer/paddock/commit/331e2ee6b5066d523bb590a4cbc67d707415c107) Thanks [@edspencer](https://github.com/edspencer)! - Mobile: collapse the stacked header into one row and tidy the composer (#372).

  On phone-sized screens the project/chat view showed two rows of chrome — the
  shell's brand bar (logo + instance name + hamburger) stacked above the project
  header (name + status + new-chat + menu). The shell now drops its brand row on
  project routes and the project header hosts the hamburger inline via an
  `openNav` Outlet context, collapsing the two into a single row and reclaiming
  vertical space. The brand still lives in the nav drawer the hamburger opens.

  The composer typography is also normalized on mobile: the anti-iOS-zoom rule no
  longer force-bumps `<select>` to 16px (it opens a native picker, so it never
  triggered focus-zoom), so the small model dropdown matches its row again; the
  Send/Stop buttons go icon-only below `sm` so the textarea keeps enough width for
  its placeholder to sit on one line; and the "Preload project context" hint
  (`(injects OVERVIEW.md + CHANGELOG.md)`) is hidden below `sm` — it's redundant
  with the label's own tooltip — so that line no longer wraps. Desktop is
  unchanged.

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

- [#368](https://github.com/edspencer/paddock/pull/368) [`0c669aa`](https://github.com/edspencer/paddock/commit/0c669aa7db44978be54b195e5d3e3e8f0908da0e) Thanks [@edspencer](https://github.com/edspencer)! - fix(#365): keep the voice-dictation mic usable while the keeper is replying

  The composer's mic button was disabled for the whole in-flight turn (`ChatPane`
  passed `disabled={streaming}` to `DictationButton`), so voice was locked out
  precisely when hands-free queuing is most useful — you could type a follow-up
  and have it queue mid-turn, but you couldn't dictate one.

  The mic now follows the same enabled semantics as the composer's text input: it
  is interactive regardless of turn state. A clip dictated during a live turn
  transcribes into the composer draft exactly like typing, and submitting it
  follows the existing single-slot queue-while-streaming path (`QueuedMessageStore`,
  auto-flush after the turn) — no new send path. Idle behaviour and transcription-
  error surfacing are unchanged. The now-unused composer-busy `disabled` prop was
  dropped from `DictationButton` (its own record/transcribe/error state still
  governs what a click does).

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
