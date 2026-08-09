# @paddock/server

## 0.66.2

### Patch Changes

- [#760](https://github.com/edspencer/paddock/pull/760) [`8253cd2`](https://github.com/edspencer/paddock/commit/8253cd2462955914386a55b4bb11ace57acb52e6) Thanks [@edspencer](https://github.com/edspencer)! - Two client-side data-loss bugs are fixed: composer attachments riding an unrelated
  message (#728), and a mid-turn remount silently discarding the assistant's reply
  (#726).

  **#728 — attachments were consumed by SENDING, never by QUEUEING.** A file staged
  while a turn was in flight stayed in the tray: `send()` returned early into the
  queue and never touched it, and the queue is flushed server-side, so the one piece
  of code that consumes the tray never ran for a queued message. The file then went
  out silently with whatever was sent next — a message the user never meant to
  attach it to.

  Attachments now travel with the queued message through the shared, server-owned
  slot (#751/#629): `chat:set_queue` carries them, they merge into the slot as a
  **union by id** (a write can only add, so a client re-asserting its queue after a
  reload — tray long since empty — cannot wipe another device's file), every client
  sees them on `chat:queued_state`, the drain sends them with the turn, and Stop
  hands them back to the tray on `chat:queued_returned` alongside the text. A slot
  may now hold files with no prose, so an attachment-only submit during a live turn
  queues instead of being a silent no-op.

  A pre-session chat's tray is also keyed per **new-chat instance** rather than per
  project. `new:<slug>` was one key shared by every future new chat, so a file staged
  on a chat the user abandoned came back pre-staged on the next one and rode its
  first message; unlike a draft, whose text is visible, that is easy to miss. The key
  still survives a reload (#346) and is rotated only by an explicit "New Chat".

  **#726 — the REST transcript snapshot full-replaced live frames.** On remount
  `ChatPane` cleared the transcript, fetched it, and applied the result wholesale.
  The socket is attached future-only by design, so every frame arriving between the
  server reading the transcript and the response landing was appended and then thrown
  away — losing the assistant's entire reply and leaving a sub-agent card spinning on
  "running" until a reload. The snapshot is now merged with what arrived during the
  fetch (tools reconciled on `toolUseId`, assistant bubbles by prefix, everything else
  by content), and is an unchanged full replace when nothing arrived — which is every
  hydration on a fast connection.

- [#755](https://github.com/edspencer/paddock/pull/755) [`01545f5`](https://github.com/edspencer/paddock/commit/01545f5011e9e987d1ab1806b8ee3cfadf42158f) Thanks [@edspencer](https://github.com/edspencer)! - Deleting something now takes its bookkeeping with it (#732, #734). Both bugs are
  the same defect one layer apart: herdctl's `job-*.yaml` records feed the sidebar
  unread badge and the run history, the directory was append-only, and **nothing
  had ever removed a record** — so a record outlived whatever it described.

  **The sidebar unread badge no longer sticks at a count you cannot clear
  (#732).** `chatTurns` — the badge's feed — was built purely from job records, and
  deleting a chat left its record behind. Delete two of three unread chats and the
  badge still read `3` while the project had one chat and the Home Unread feed
  correctly reported `1`; mark the survivor seen and the badge dropped to `2` with
  **no chat left to open** to clear the rest. Reload didn't help — it is what the
  server said.

  Fixed at both ends. A chat's job records are dropped when the chat is deleted
  (one choke point, so the per-chat and batch routes both get it), and
  `GET /api/projects` prunes `chatTurns` against the chats that actually exist — so
  an instance already stuck self-heals, and a transcript that leaves by some other
  route (an adoption undone, a JSONL removed by hand) cannot re-stick it. A failed
  chat listing is treated as _unknown_, never as _empty_, so a transient error
  leaves the badge alone rather than silently zeroing it.

  The client half is fixed too, and it is the half that matters on the default
  `session` drive mode: that runtime writes no job records at all, so the badge is
  fed mostly by live turn-completions over the WebSocket, held in a cache that also
  only ever grew. Deleting a chat now retracts it from that cache immediately, and
  completions belonging to a project that has gone away are dropped on the next
  projects fetch.

  **An archived chat is now silent on both surfaces.** It used to count toward the
  sidebar badge while being excluded from `/chats/attention`, so the badge could
  read `3` with the Home Unread feed showing nothing — the two surfaces disagreeing
  about the same state, which is exactly what making read state server-authoritative
  (#488) was meant to rule out. Archiving is the user filing a chat away, so it now
  silences both. It silences rather than consumes: unarchiving brings the chat back
  to both surfaces.

  **Deleting a project and creating a new one with the same name no longer
  resurrects the old one's history (#734).** Job records are keyed by agent name,
  which derives from the slug, which derives from the _name_ — so a re-created
  "Foo" inherited the previous incarnation's `/runs`, prompt text and reply
  summaries included, plus a phantom unread badge over a project with zero chats.
  Files, `.chats/` and `read-state.json` were already cleaned; these were the one
  thing left. A project delete now purges the records of every agent it owned
  (keeper, sweeper, hooks, triggers), so the inverse of create is complete.

  This is the containment fix, not the structural one: the durable answer is to key
  records by a stable project id rather than by a user-controlled, reusable slug,
  which is a change to herdctl's record format. Purging on delete closes the leak
  now and stays correct afterwards.

- [#757](https://github.com/edspencer/paddock/pull/757) [`8e7ba1d`](https://github.com/edspencer/paddock/commit/8e7ba1de344ce5f7951ff6a2c023480aabae9dfc) Thanks [@edspencer](https://github.com/edspencer)! - The `/config` screen can now tell you what is actually in `paddock.config.yaml`
  (#722), and a `null` on a numeric field clears the key instead of writing `0`
  (#723).

  **One root cause behind three symptoms (#722).** `buildInstanceConfig` built the
  GET response out of the boot-frozen `PaddockConfig` and never read the config
  file, so `GET /api/instance-config` could not observe _any_ write — including one
  the same client had just made a millisecond earlier. Everything followed from
  that:

  - **A successful save appeared to revert.** The form re-fetches after writing and
    clears its dirty set; the re-fetch returned the pre-save values, so setting
    _OVERVIEW.md max tokens_ to `1234` wrote `1234` to disk, showed a green "Saved
    to disk", and put `2000` back in the box.
  - **Two tabs silently last-writer-won.** Tab A saving `1111` left tab B still
    displaying `2000` with nothing — not polling, not an ETag — able to reveal it,
    because the value B would have polled for was never read from the file.
  - **`restartRequired` was hardcoded `false`**, so nothing ever said that the file
    had diverged from the running process.

  The DTO now carries **two** values per field: `value` (in force now, out of the
  frozen config) and `pendingValue` (what the file says this instant, i.e. what a
  restart would load), plus `pendingRestart` where they differ. The editor binds to
  `pendingValue` — it is an editor for the file — so a save round-trips, another
  tab's write is visible on the next load, and the field says what is still in
  force. `restartRequired` falls out as "some field diverges" rather than being
  asserted.

  Pending values are computed for editable, non-env-shadowed fields only: an
  env-shadowed field resolves to the same env value after a restart, and the
  read-only `advanced` bindings are normalised at boot (paths canonicalised, `port`
  `Number()`-ed), so comparing them against raw file text would report divergence
  that isn't there. A file that exists but won't parse is reported as
  `configFileError` instead of being silently read as "nothing pending" — the
  screen that exists to fix a broken config should say it is broken.

  **Saves are conditional.** The GET returns a `configVersion` (a fingerprint of
  the file) which the UI echoes back as `expectedVersion`; a write composed against
  a stale snapshot gets a 409 and the file is left alone, instead of the second tab
  quietly erasing the first. The client keeps the operator's edits, reloads, and
  lets them save again deliberately. `expectedVersion` is optional, so a script or
  `curl` writes unconditionally as before.

  **`null` on a `nonNegInt` field now clears the override (#723).** The PUT
  contract is that a `null` deletes the key; `nonNegInt` used `Number(raw)`, and
  `Number(null)` is `0` — a finite, non-negative integer — so
  `{"recovery.maxRetries": null, "recovery.debounceMs": null}` wrote zeros. Those
  are not a no-op: `maxRetries: 0` stops chat recovery retrying at all. The
  validator now has the same explicit `null` / `""` / `undefined` branch as its
  `optNonNegNumber` sibling, and a deliberate `0` still works. `maxSpawnDepth` had
  the same hole (a "clear this" wrote depth 0, which switches off every child's
  self-MCP) and is fixed with it.

  The same missing type check let `Number()`'s coercions through: `true` wrote `1`,
  `[7]` wrote `7`, `false` wrote `0`. Numeric fields now take a number or a numeric
  string and nothing else.

  **Two smaller holes found in the same audit.** Writing a field that a `PADDOCK_*`
  env var currently shadows returned 200 + `restartRequired: true` for a write that
  could never take effect (the UI already rendered those read-only; the API did
  not) — it is now a 400 naming the variable. And numeric and string fields had no
  upper bound: a 200 KB `brand.name` produced a 200 KB `paddock.config.yaml` that
  every boot then had to parse. Numbers are capped at 1e9, plain strings at 1024
  characters, list fields at 64 entries (the prompt-shaped `environmentPrompt`
  keeps its own, much larger 32 KiB cap).

  None of the existing validation is relaxed: negative/zero/fractional budgets,
  bad enums, unknown/read-only keys, unknown model ids, non-hex colours, NUL bytes
  and oversized prompts are all still rejected, and the file still round-trips
  through the `yaml` `Document` API with operator comments intact.

- [#754](https://github.com/edspencer/paddock/pull/754) [`e35090b`](https://github.com/edspencer/paddock/commit/e35090b4130eee4bd14d30633f3d4759370a79de) Thanks [@edspencer](https://github.com/edspencer)! - Four defects in project path handling and `PATCH /api/projects/:slug` are fixed
  (#718, #719, #720, #721). All four live in `projects.ts` / `project-paths.ts`,
  and two of them are the same underlying problem, so they are fixed together.

  **`isPathInside(child, "/")` is no longer false for every child (#719).** The
  `+ path.sep` that makes the helper correct everywhere else — it is what stops
  `/data/projects-old` counting as a child of `/data/projects` — asked for
  `startsWith("//")` when the parent was the filesystem root, so every child of `/`
  reported as outside it. The separator is now appended only when the parent does
  not already end in one, with unit cases for `parent === "/"` sitting next to the
  `/data/projects-old` case that motivated the original form.

  The consequence was that the bidirectional overlap guard in `validatePath()`
  failed open in **both** directions once any project's working directory was `/`:
  a second project could be created overlapping the first, and two keepers sharing
  a working tree collide on transcripts, which are keyed by cwd. The same helper
  backs `rmInsideRoot()`, where the bug was fail-safe (a delete was refused rather
  than wrongly allowed) — so no data was ever at risk — but it is the containment
  primitive from #709 and is worth being exactly right. `rmInsideRoot` now also
  refuses a degenerate projects root of `/` explicitly, rather than depending on
  the bug that used to make that case safe by accident.

  **A project can no longer be linked at `/`, `/etc`, `/dev` or `/proc/self/cwd`
  (#720).** `validatePath()` had no floor beneath which a path could not back a
  project, and a linked directory becomes a keeper's cwd — running `acceptEdits`
  by default. With `managed: true` (the New Project modal's "let Paddock curate
  them" checkbox) that directory is also the project's `contentDir`, so the sweeper
  writes `CLAUDE.md` and `CHANGELOG.md` into it.

  This is a **footgun, not a privilege escalation** — anyone who can reach this API
  can already create projects and run turns as whoever Paddock runs as — so the fix
  is deliberately small: a denylist of system roots (`isSystemPath`), each denying
  itself and everything under it, checked on the canonicalised path so a symlink
  pointing at `/etc` is refused for where it really goes. `/proc/self/cwd` is
  refused on the path as _written_ as well, because it canonicalises to an ordinary
  directory and would otherwise pass — a `/proc` path is process-relative, which a
  cwd baked into every transcript path can never be. `/opt`, `/srv`, `/mnt`,
  `/tmp`, `/root` and `/var` are deliberately still allowed; the alternative the
  issue floated, a configurable allowed root, adds a config dimension and would
  invalidate every already-linked project the day it shipped. The floor applies at
  create time only, so an existing project already linked at a system path keeps
  working across the upgrade.

  **`repo` is immutable on PATCH again (#718).** `repo` is the third field feeding
  `workingDirFor()`, alongside `path` and `managed`, which were already re-asserted
  from the current record for exactly this reason. `update()` validated it with
  neither `isValidRepoUrl()` (as `create()` and `promote()` both do) nor the
  re-assertion, so `PATCH {"repo":"not a url at all ;rm -rf /"}` returned 200 and
  relocated **both** `workingDir` and `contentDir` to `<dir>/not-a-url-at-all--rm--rf`
  — a directory that does not exist. The project was left bricked: every subsequent
  turn hung 60s waiting for a session file and failed, with the existing chats
  stranded on the old cwd. Acquiring a repo for an existing project is what
  `promote()` is for.

  **Arbitrary PATCH body keys are no longer persisted verbatim (#721).**
  `update()` built the next record as `{...stripDto(current), ...rest}` — the DTO
  fields were stripped from the _current_ value and then the untrusted body was
  spread straight back in, so any invented key landed in `project.yaml` unbounded,
  in a file re-parsed on every `/api/projects` call. The body is now filtered
  against a `PATCHABLE_KEYS` allowlist (the runtime half of `UpdateProjectInput`,
  with a `satisfies` drift guard); unknown keys are dropped and logged rather than
  rejected, so a client sending a superset still works. This also closes a smaller
  hole in the same shape: `pinned` is owned by the `/pins` endpoints and was
  patchable here.

  #718 and #721 are one fix — the PATCH route trusting its body far more than
  `create()` does — covered by a regression test asserting the property that
  matters: **a PATCH cannot move a project's `workingDir`**, which covers `path`,
  `managed` and `repo` together.

## 0.66.1

### Patch Changes

- [#751](https://github.com/edspencer/paddock/pull/751) [`7b49713`](https://github.com/edspencer/paddock/commit/7b4971389ea690d3ba9c5944a29d7da3e6d0f106) Thanks [@edspencer](https://github.com/edspencer)! - Three ways a queued message could be silently lost are fixed (#736, #629, #627).
  All three live in the same handful of lines, so they are fixed together.

  **A client with a fast clock no longer destroys every later queued message
  (#736).** The drain's dedup marker was keyed on a _client-supplied_ timestamp and
  compared as an ORDERING — "older than the last flush, and timestamps being
  monotonic, that can only be a stale re-assert". Timestamps are monotonic within
  one client; this one came from whichever browser queued the message. So a laptop
  five minutes fast parked the marker in the future, and every queued message on
  that chat afterwards — from _any_ client — was taken from the store, classified
  already-flushed, deleted and never sent, with the chip cleared and no error, until
  wall-clock time caught up. Confirmed in a real browser with `Date.now` shifted.

  A queued message's identity is now an opaque id, compared only for equality, and
  the enqueue time is stamped server-side. Nothing about clocks is assumed anywhere.
  The `(id, text)` tuple from #628 is unchanged in behaviour: an append keeps its id
  with longer text, so it is still a genuinely new message, and a reloaded client
  re-asserting exactly what was already flushed is still recognised and cleared.

  **A second client's queue merges into the chat's one slot instead of overwriting
  it (#629).** The slot is one-per-chat and `set()` was a bare overwrite, so a
  second tab (or a phone, or one stale tab left open) destroyed the first client's
  message unrecoverably — no error, and the first client's chip went on showing a
  message that no longer existed anywhere. Worse, when the drain fired, that
  client's own transcript rendered the _other_ client's text as a user bubble they
  had never typed.

  The queue is now shared chat state: a new `chat:queued_state` frame is broadcast
  to every socket attached to the session whenever the slot changes, so all clients
  render the same thing, and a client that queues without having seen what is
  already there has its text appended rather than substituted for it. One slot, one
  chip, nothing lost.

  **A queued message escapes on every turn-ending path, not just `chat:send`
  (#627).** `drainQueue` was called from exactly one of the eight `turn.end()`
  sites. A message queued during `/compact` or any slash command, a trigger or
  spawned turn, a scheduler wake, a background sub-agent stretch, or a turn the user
  Stopped, was persisted and then stranded — escaping only when some _later_
  `chat:send` completed, which put it in the transcript **behind** a message typed
  minutes afterwards, with a stale chip sitting above the composer in between.

  The drain now hangs off a turn-end hook on the session hub, which every one of
  those paths already goes through, so this is structural rather than a list of call
  sites to remember to extend. It also sits above the batch/session runtime split,
  so both drive modes behave identically.

  **Stop is the one exception, and it hands the message back rather than sending
  it.** "Give me control back" and "start working again immediately" are opposites,
  so the message queued behind a Stopped turn goes into the composer of the client
  that pressed Stop — by the same path the queued bar's Edit button has always
  used, so it merges with whatever was already typed and persists as an ordinary
  draft. Other clients watching the chat see the shared slot clear with a reason
  attached rather than a chip vanishing for no visible cause. If there is nobody
  left to hand it to (the tab closed between the Stop and the turn ending), the
  message stays queued and is parked so no later turn end sweeps it out behind
  something typed afterwards — and a pane opening the chat is now told what is
  queued on it, so a parked message is never invisible.

  The destructive-op interlock (#731) is excluded too: it cancels a turn precisely
  so it can delete, revert or promote the transcript, and starting a fresh turn
  there would both race that and keep the session busy so the interlock could never
  settle.

  Also in the same area: a queued message is capped at 100,000 characters (a 2 MB
  `chat:set_queue` used to be accepted and persisted verbatim, and the sidecar is
  rewritten in full on every queue mutation), and the in-memory flushed-message
  ledger is bounded per chat and per server.

## 0.66.0

### Minor Changes

- [#741](https://github.com/edspencer/paddock/pull/741) [`18c11e0`](https://github.com/edspencer/paddock/commit/18c11e0ca36fa43f511ab07c9c68ace250167fef) Thanks [@edspencer](https://github.com/edspencer)! - The default listen port moves from **4000** to **7233**.

  4000 was a bad default. It is one of the most contested ports in local
  development — Jekyll has defaulted to it since 2008, Phoenix defaults to it, and
  it is a common pick for a hand-rolled Node server. The CLI has carried a comment
  calling `EADDRINUSE` on 4000 "the likeliest first-run failure" for as long as the
  error message has existed, which is a fair description of a default that makes
  the first run fail.

  7233 is `PADD` on a phone keypad (P=7, A=2, D=3, D=3). It is **not** registered
  with IANA — checked against the published registry — and carries no malware
  association.

  **It is not unoccupied.** 7233 is the default frontend gRPC port for
  [Temporal](https://docs.temporal.io/temporal-service/temporal-server), whose
  7233/7234/7235/7239 block covers its frontend, history, matching and worker
  services. That collision is real and worth naming, because Temporal's audience —
  self-hosting developers running orchestration — overlaps ours more than the base
  rate would suggest. It is still the better trade: Temporal is one specific
  server, almost always run under Compose or k8s where the published port is
  trivially remapped, whereas 4000 collides with a whole class of everyday tooling.
  The failure mode is also loud rather than silent — `EADDRINUSE` at boot, with the
  existing message naming the port and the flag that fixes it.

  **Upgrading:** if you set `PORT`, `port:` in `paddock.config.yaml`, or `--port`,
  nothing changes. If you relied on the default, the instance moves to 7233 and
  anything in front of it — a reverse proxy `reverse_proxy paddock:4000`, a Docker
  `-p 127.0.0.1:4000:4000` publish, a k8s Service `targetPort`, an SSH tunnel —
  needs the new number, or pin the old one with `PORT=4000`.

- [#735](https://github.com/edspencer/paddock/pull/735) [`43f5603`](https://github.com/edspencer/paddock/commit/43f56038ec0e3fd0569a4f8ae9a22490df9b33d6) Thanks [@edspencer](https://github.com/edspencer)! - `project.yaml` and `paddock.config.yaml` now declare a `schemaVersion`, and
  Paddock refuses to lenient-parse a file written by a newer version of itself
  (#724).

  The motivating problem is not migrations, it is **downgrades**. Running an older
  Paddock — `npx @edspencer/paddock@0.62.0` is one command away — against a data
  dir a newer one wrote used to read it leniently: the project normaliser drops
  every key it does not recognise, and the next save writes the file back without
  them. A `path:` or a `managed:` disappeared with no error and no way to notice.

  The two on-disk formats Paddock owns now carry `schemaVersion: 1`, and a file
  declaring a version this build does not understand is never lenient-parsed:

  - **`paddock.config.yaml` from the future → refuse to start**, naming the file,
    both versions, and the fix. Fail-closed, in the same shape as the existing
    refusal when the Claude home resolves to your own `~/.claude` — an instance
    config decides auth mode and bind host, and half-understanding those is worse
    than not booting.
  - **A `project.yaml` from the future → that project is skipped, loudly**, with a
    startup warning naming the file and its version; the rest of the instance is
    unaffected and the file is left byte-for-byte alone. Deliberately _not_ a
    refusal: an unreadable `project.yaml` already made a project vanish silently,
    so saying it out loud is a strict improvement, whereas bricking a whole
    instance because one project directory was copied in from a newer box would be
    a worse failure than the data loss being prevented.

  **Adoption touches no existing data.** The current on-disk shape _is_ version 1
  and an **absent** `schemaVersion` reads as 1, so every file on every live
  instance already reads correctly and nothing is rewritten. Files Paddock writes
  from now on carry the field explicitly; existing ones pick it up whenever they
  are next saved for some other reason. There is no backfill pass, and merely
  reading a file still writes nothing to it.

  No migration runner ships with this — with `1` as the only version there is
  nothing to migrate, and one with zero migrations cannot be meaningfully tested.
  The rule for when to bump the number (monotonic integer, never semver; adding an
  optional key does **not** bump) is documented next to the constants in
  `schema-version.ts`.

### Patch Changes

- [#739](https://github.com/edspencer/paddock/pull/739) [`d75b610`](https://github.com/edspencer/paddock/commit/d75b610a91f281c91c4d3b24df02ae916cc3816d) Thanks [@edspencer](https://github.com/edspencer)! - test: add a `[[BGSUBAGENT]]` fake-Claude directive for a sub-agent that outlives its parent turn

  The fake could not previously produce a sub-agent that is still running with no
  live parent turn holding it open. Every existing directive keeps the parent turn
  alive for as long as the sub-agent runs — `[[SUBAGENT]]` pairs the `Task` only
  after its nested steps finish, and `[[SLOWTOOL]]` holds the turn open by design.

  That gap made a whole bug class structurally untestable. Sub-agent progress is
  polled over REST rather than streamed, and a live parent turn is exactly what
  keeps the poll alive, so a nav-away/nav-back test written on either directive
  **passes while the bug is live** (#725).

  `[[BGSUBAGENT]]` pairs the `Task` tool_result immediately, lets the turn run on
  to its terminal `result`, and then keeps appending sidechain steps for
  `PADDOCK_FAKE_BGSUBAGENT_MS` (default 3000ms) — the detached state the bug needs.

  Test-harness only: `test/bin/claude` is not part of the published package, and no
  product code changes.

- [#743](https://github.com/edspencer/paddock/pull/743) [`bfc5fa9`](https://github.com/edspencer/paddock/commit/bfc5fa9aacaa38233c23ec6e29e77409f72c78c6) Thanks [@edspencer](https://github.com/edspencer)! - Destructive chat operations now stop an in-flight turn instead of racing it
  (#731). Deleting a chat mid-turn used to lose the whole conversation.

  A chat's transcript is written by `claude` itself, straight through the symlink
  Paddock plants — Paddock never holds the file handle. So unlinking the JSONL
  while a turn was live did not delete the chat: the surviving process wrote itself
  back, and the chat returned named after its raw session id with a 3-line
  transcript that opened on an orphan `tool_result` and no prior history at all.
  Promote lost the chat from **both** projects — the source resurrected a stub, the
  target's list came up empty, and `adoptable-chats` reported nothing, so the UI
  offered no way back. A hung turn was never reaped, leaving a `claude` child alive
  and a `status: "running"` run row that never cleared.

  `DELETE /chats/:id`, `POST /chats/batch/delete`, `POST /chats/:id/revert`,
  `POST /chats/:id/promote` and `DELETE /api/projects/:slug` now cancel the turn
  and **wait for it to be verifiably dead** before touching a byte, reporting
  `cancelledTurn: true` when they did. Each is an unambiguous "this chat's current
  state is going away", and refusing instead would strand the user behind a turn
  that may never end. If the turn cannot be confirmed dead within 10s they return
  `409 { code: "turn_running" }` rather than mutate under a live writer — the
  resurrection is impossible by construction, not by winning a race.

  Fork is deliberately **not** interlocked: the `fork_chat` fan-out (#214) is
  invoked by a keeper from inside its own running turn, so the source is always
  mid-flight there and refusing would break that contract. Instead the _copy_ is
  trimmed back to the last point where every `tool_use` has its `tool_result`, so a
  mid-turn fork is no longer born with a transcript the Messages API rejects on
  resume. The source is untouched either way, and an idle fork is copied
  byte-identically as before.

- [#750](https://github.com/edspencer/paddock/pull/750) [`9f3ae4e`](https://github.com/edspencer/paddock/commit/9f3ae4e8b0e93d979bb0398a8b98e82e4c70fdc8) Thanks [@edspencer](https://github.com/edspencer)! - A still-running sub-agent keeps its place in the running-sub-agents bar, and a
  sub-agent's nested steps no longer reappear as top-level transcript rows after a
  reload. Two `/messages` payload bugs where the live path and the history path
  disagreed and the history path was wrong.

  **A live sub-agent was being handed a final duration (#725, cause A).**
  `subagentDurationMs` is not decoration — it is the client's _finished_ signal, and
  it is computed from the first→last timestamp of a transcript that may still be
  growing. `attachSubagentFields`' `pending` branch already knew that and withheld
  the field (#622). The `paired` branch below it stamped one unconditionally, and
  because the SDK **backgrounds** sub-agents, the launching `Task` tool_result pairs
  within milliseconds while the sub-agent keeps working — so a live sub-agent
  reached the paired branch as a matter of course, was declared finished, and was
  dropped from the bar for the rest of the run. A reload did not recover it: it
  re-derives from the same code. The tell was a "final" duration that kept climbing:
  9211 → 11296 → 13368.

  The gate now lives at the source, so both branches are covered by construction: a
  duration is published only for a sub-agent whose own transcript has actually
  settled — its last line is a terminal assistant `end_turn`, or it has been quiet
  for ten minutes (the fallback that keeps an _interrupted_ sub-agent, which never
  writes an `end_turn`, from claiming "running" forever).

  Worth recording, because the issue proposed it and it does not work: a sub-agent
  transcript has **no** `type: "result"` line to look for. Zero of the 483 real ones
  this was measured against carried one, so "has a terminal result line" would have
  withheld every duration, always. `end_turn` is the marker that actually appears
  (392 of 483, and mid-file exactly once).

  **Sub-agent sidechain steps leaked into history (#727).** A sub-agent's steps
  belong inside its `Task` card, served by the subagents endpoint. The live path
  enforces that in five places via `isSidechainMessage`; the history path had no
  equivalent, because `@herdctl/core` treats `isSidechain` as a whole-_session_
  property and drops the per-line marker from the messages it returns. Any sidechain
  line written into a main transcript therefore came back out of `/messages` as a
  first-class top-level row, rendered as a sibling of the card rather than inside it.
  The markers are now recovered from the raw transcript — on `isSidechain` _or_
  `parent_tool_use_id`, since the writers disagree about which they stamp — and the
  rows dropped before any of the file-order joins count positions.

- [#742](https://github.com/edspencer/paddock/pull/742) [`0182c5c`](https://github.com/edspencer/paddock/commit/0182c5c91a86128383a886898fa9adb4597207ca) Thanks [@edspencer](https://github.com/edspencer)! - Fix silent data loss: the message you send right after deleting a chat no longer
  lands in a brand-new session (#730).

  The reproduction is an everyday one. Delete the chat you have just finished, go
  back to an older one, send a message — and under `driveMode: batch` the message
  was silently misfiled into a session that did not exist a moment ago. Nothing
  looked wrong: the URL and the transcript on screen kept showing the chat you were
  in, and the reply streamed into it. Only on reload did the message turn out to be
  gone from that chat, with a stray new chat in the sidebar holding it — and the
  keeper's answer had already been written with no memory of the conversation,
  because it was a fresh session. It cost exactly one turn: the next send worked.

  **What was actually happening.** herdctl keeps one "current session" pointer per
  agent at `<stateDir>/sessions/<agent>.json`, rewritten after every batch turn, so
  it always names that project's most-recently-active chat. Deleting that chat left
  the pointer naming a transcript that was no longer on disk. On the next turn —
  any chat, with its session id passed explicitly — herdctl's JobExecutor found the
  pointer dangling, cleared it, and then **refused the explicitly-requested resume**
  because a pointer had existed a moment earlier, which it reads as "this agent's
  session just expired, so start fresh". The pointer named the deleted chat; the
  caller asked for a different one; that chat's transcript was right there.

  Every rule the bug reproduction turned up falls out of that: only deleting the
  **most-recently-active** chat broke anything, `archive` never did (it removes
  nothing, so nothing dangles), `promote` did (it deletes the source transcript by
  the same call), the damage was scoped to one project (one pointer per keeper),
  and it was one-shot (the fresh turn rewrote the pointer).

  **The fix** is one `rm` of a file that is already dangling by the time we reach
  it: when Paddock deletes or promotes a transcript, it now clears the agent-level
  pointer if that pointer names it. herdctl would have cleared the same file at the
  next turn regardless — doing it at the moment we make it dangle means the next
  turn sees a clean "this agent owns no session" and adopts the caller's explicit
  resume, which is the same path a process restart took, and why this always
  "worked after a restart". Another chat's pointer is left alone.

  The misreading itself is an upstream bug and the real repair belongs there —
  filed as edspencer/herdctl#448, which also notes that any consumer whose
  transcripts vanish by some other route (a manual `rm`, a retention sweep, a
  crashed write) hits the same misclassification. `driveMode: session`, the
  default, was never affected: the SDK session path does not consult the pointer
  when the caller names a session.

  Pinned by `resume-after-delete.test.ts` at the integration tier — a turn after a
  delete, and after a promote, must land in the chat it was addressed to, with that
  chat's history behind it. There was previously no test anywhere that sent a turn
  _after_ a delete.

## 0.65.0

### Minor Changes

- [#668](https://github.com/edspencer/paddock/pull/668) [`25fe4cc`](https://github.com/edspencer/paddock/commit/25fe4cc8d7e24a5917bfbe9b770a59d73b7ef217) Thanks [@edspencer](https://github.com/edspencer)! - Self-management MCP: add `promote_project` (notebook → repo-backed) (#470)

  `POST /api/projects/:slug/promote` (#213) has been able to turn a notebook
  project into a repo-backed one in place since long before agents could drive
  Paddock — but there was no MCP verb for it, so an agent that realised its
  notes-only project should have been a codebase had to stop and ask a human. It
  could `create_project` a _second_, repo-backed project and abandon the first,
  which loses the chats.

  `promote_project` takes a required `repo` git URL plus an optional `project`
  slug (defaulting to the current project, so an agent can promote the workspace
  it is running in). It clones the repo into the project's nested checkout, flips
  the agent's working directory to it, and re-registers the agent — which
  re-symlinks that new working directory at the project's existing `.chats/`
  store, so every chat stays listed and resumable.

  Under the hood it calls the same `ProjectStore.promote` + `ensureProjectAgent`
  pair the REST route does, in the same order, so the two paths can't drift.
  Every guard stays in the store: an already-repo-backed project is refused, so is
  the root workspace, and a failed clone rolls back to a byte-identical notebook.
  Server filesystem paths are stripped from a clone error before the agent sees it.

  It rides on the **existing** `selfMcpProjectsEnabled` / `PADDOCK_SELF_MCP_PROJECTS`
  flag rather than getting a third one — same blast-radius class as
  `create_project`, and an operator who has granted "this agent may provision
  projects" has already made the decision promotion asks for. No new config, and
  no change to the tool surface of an instance that hasn't opted in.

## 0.64.0

### Minor Changes

- [#709](https://github.com/edspencer/paddock/pull/709) [`2655f7c`](https://github.com/edspencer/paddock/commit/2655f7c0c1c57cdd78b0f4be4cc9db530e5b91a6) Thanks [@edspencer](https://github.com/edspencer)! - Projects are described by two independent axes instead of one overloaded flag,
  and a project can point at a directory you already have (#206, #597).

  **`managed` replaces `repoBacked`.** A project is _managed_ when Paddock looks
  after its own files — the sweeper curating `CLAUDE.md`, `OVERVIEW.md` and
  `CHANGELOG.md`, which is what "notebook" used to mean — and _unmanaged_ when the
  content is code you or your agents source-control outside Paddock. Whether a git
  repo sits behind it is a separate question, and not a type: it is just which of
  `path` and `repo` are set. `repoBacked` was one boolean answering four questions
  and has been removed from the DTO; each consumer now takes the fact it needs.

  **`path:` — where a project's content lives.** An absolute directory, applying to
  both axes. Unmanaged, it links a checkout you already have — used in place, with
  no copy, so Claude gets its real history, branches and remotes; Paddock writes
  nothing into it (no `.chats/`, no sidecar `.gitignore`, no `CLAUDE.md`), and
  deleting the project never touches it. Managed, it nominates where your notes
  live, and the curated trio follows the content out there — an accepted
  consequence being that those three files then do not live in the Paddock data
  dir. Either way `project.yaml` (the registry entry) and `.chats/` stay put.

  Acquisition follows from what you give it: an existing path is used as-is (with a
  warning, not a failure, if a declared `repo`'s remote doesn't match it); a missing
  path is cloned into when a `repo` is given, or created for a managed project. A
  failed create only ever removes directories it made during that attempt, never
  one that already existed.

  **No git requirement.** Paddock probes for git and lights up the git features when
  it finds a repository; it never rejects a directory for not being one.

  **The Changes tab reports on the working directory (#597).** It read the metadata
  directory before, so for a repo-backed project it showed the notes folder rather
  than the code — and repo detection was asked of the projects root rather than the
  directory in question. Both are now per-directory.

  `managed` is optional on disk and its default is derived (`managed ?? !(repo ||
path)`) so existing `project.yaml` files keep their current meaning on upgrade;
  `managed: true` together with `repo` is rejected rather than silently reinterpreted.
  `managed` and `path` are immutable after creation.

### Patch Changes

- [#707](https://github.com/edspencer/paddock/pull/707) [`7bcb8bd`](https://github.com/edspencer/paddock/commit/7bcb8bd9566293ae77369525232289bf67dc09d9) Thanks [@edspencer](https://github.com/edspencer)! - The `claude.instructions: own` startup notice is now a warning, so you actually
  see it. It names which of your `~/.claude` files (`CLAUDE.md`, `agents/`,
  `commands/`, `plugins/`) are not being loaded and which key turns them back on —
  but it was written at `info`, and `npx @edspencer/paddock` sets `LOG_LEVEL=warn`
  unless you pass `--verbose`, so on the documented install path the one population
  the notice exists for never saw it (#706). It still says nothing when you have no
  such files, or when you are on `claude.instructions: host`.

## 0.63.0

### Minor Changes

- [#705](https://github.com/edspencer/paddock/pull/705) [`571def3`](https://github.com/edspencer/paddock/commit/571def3a8768f3b49c0d4fb6cfda19a4cc7c2905) Thanks [@edspencer](https://github.com/edspencer)! - Inherit the host's Claude Code **plugins**, and stop degrading `sse` /
  header-authenticated MCP servers (#700).

  Requires `@herdctl/core` 5.32.0, which adds the two things Paddock had no channel
  for.

  **Plugins.** A plugin that provides an MCP server — a Slack plugin installed on
  your laptop, say — was invisible in Paddock on every setting, because the SDK
  enables a discovered plugin from `enabledPlugins` in the **user** settings source
  and Paddock's agents are invoked with `setting_sources: ["project"]`. Paddock now
  enumerates the host's installed plugin directories from the CLI's own
  `installed_plugins.json` registry and passes them explicitly, which needs no
  settings-source grant. Two levers gate it, because a plugin is mostly
  instructions and only sometimes MCP servers:

  | `claude.instructions` | `claude.mcpServers` | what a keeper gets                                     |
  | --------------------- | ------------------- | ------------------------------------------------------ |
  | `host`                | `host`              | the plugin, including its MCP servers                  |
  | `host`                | `own`               | the plugin's commands/agents/skills/hooks only         |
  | `own`                 | _any_               | no plugins (`instructions` is what bridges `plugins/`) |

  Each plugin server's `mcp__plugin_<plugin>_<server>__*` pattern is added to the
  keeper's allowed tools automatically — without it the server connects and then has
  every call auto-denied with no prompt. A plugin whose manifest points `mcpServers`
  at a bundle rather than declaring them inline cannot be enumerated that way; it is
  still attached, and a boot warning names it and the pattern to add by hand.

  **MCP server fields.** `headers` and an explicit `type` (`sse`) are now carried
  through verbatim instead of being stripped. So a bearer-authenticated or `sse`
  server inherited under `claude.mcpServers: host` arrives intact and finds its
  stored OAuth token (which is keyed on a hash of `{type, url, headers}`), and the
  boot warnings v0.62.0 shipped for both are gone. The instance's own `mcpServers:`
  block accepts both keys too — `headers` values take `env:VAR_NAME` references like
  everything else there, and are never printed.

### Patch Changes

- [#703](https://github.com/edspencer/paddock/pull/703) [`a789260`](https://github.com/edspencer/paddock/commit/a789260df837a0629b29629fe6e5558e850e3288) Thanks [@edspencer](https://github.com/edspencer)! - `paddock --help` now documents the fifth sharing lever.

  The "Sharing your Claude Code state" section listed four keys —
  `transcripts`, `credentials`, `instructions`, `hooks` — and omitted
  `claude.mcpServers`, which shipped alongside them in #691 step 5. Someone
  reading `--help` to find out what an instance shares would have concluded that
  MCP servers were not part of the block at all.

  It now lists all five, and adds a line for the sibling top-level `mcpServers:`
  block (#691 step 6) — the way to give an instance a server the host machine does
  not have, which is the case `host` cannot serve. That line also carries #702's
  caveat, so `--help` does not imply more than `env:VAR_NAME` delivers: it keeps a
  credential out of the git-tracked file, and under `driveMode: batch` it does not
  keep it out of `ps`. Help text only; no behaviour change.

- [#702](https://github.com/edspencer/paddock/pull/702) [`f5cf1d2`](https://github.com/edspencer/paddock/commit/f5cf1d28a00b1de747b71e9362569532da0fd9d2) Thanks [@edspencer](https://github.com/edspencer)! - Say where a declared MCP server's credential actually ends up (follow-up to
  #691 step 6).

  `mcpServers:` keeps a resolved secret out of every surface Paddock owns — the
  boot log, error messages, the Settings API. It does that completely, and it was
  still not the whole story: on the **CLI runtime** (`driveMode: batch`) the engine
  serialises the entire server definition, `env` values included, into a single
  `--mcp-config` **command-line argument**. A process argument is world-readable on
  Linux, so the token is legible to any local user through `/proc/<pid>/cmdline`
  and `ps` for as long as the turn runs.

  The default `driveMode: session` does not have this problem: the same record goes
  to the SDK in-process, and the stdio server it spawns receives the value in its
  environment, where `/proc/<pid>/environ` is owner-only — which is where Claude
  Code itself puts it.

  Paddock cannot close this from its side (the fix is upstream: the Claude CLI's
  `--mcp-config` also accepts a _file path_), so it refuses to be silent instead.
  An instance on `batch` with a credential-carrying declared server now gets a
  **warning** at startup naming the server; one on `session` gets the same as an
  informational note, because a single project pinning `driveMode: batch` brings
  the exposure back. Documented alongside the block.

  Verified rather than inferred: a new integration test drives a real turn and
  reads the token back out of the spawned process's argv. It is a characterisation
  test — if it ever starts failing, the engine has stopped doing this and both the
  test and the warning should be deleted.

## 0.62.0

### Minor Changes

- [#696](https://github.com/edspencer/paddock/pull/696) [`bcc9c40`](https://github.com/edspencer/paddock/commit/bcc9c409ec7a7977e29ca03eea45e3d7bb9ab8c4) Thanks [@edspencer](https://github.com/edspencer)! - `claude.credentials: own | host` — Paddock uses the Claude Code login you already
  have (#691 step 3, fixes the #683 regression 0.61.1's successor introduced).

  ```yaml
  claude:
    credentials: host # own | host — default host
  ```

  Making Paddock always own its Claude home fixed four things and broke one: Claude
  Code files its secure-storage entry under a service name derived from
  `CLAUDE_CONFIG_DIR`, so the moment Paddock set that variable, a macOS `claude
/login` became invisible. On a Mac with no token in the environment that is an
  instance which boots cleanly, reports itself ready, and fails every single turn
  with "Not logged in". This is the lever that gets the login back without giving
  the Claude home back.

  - **`host` (the default)** — Paddock uses this machine's Claude Code login: the
    macOS Keychain entry on darwin, your `~/.claude/.credentials.json` elsewhere
    (symlinked in, never copied). Nothing else travels with it.
  - **`own`** — only a login of this instance's: a `CLAUDE_CODE_OAUTH_TOKEN` /
    `ANTHROPIC_API_KEY` in the environment, or a `.credentials.json` inside
    Paddock's own Claude home. A `.credentials.json` symlink a previous boot
    bridged in is withdrawn.

  `PADDOCK_CLAUDE_CREDENTIALS` overrides the file, as usual.

  **This is the one key in the `claude:` block that defaults to `host`, and the
  exception is deliberate: isolation is about writes.** Reading a Keychain entry
  creates, moves and deletes nothing of yours; defaulting it to `own` would
  recreate #683 for every Mac user who has never exported a token. The guarantee
  `own` everywhere buys — nothing outside the data dir is written — is untouched by
  it.

  Mechanically, `host` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` in the environment
  the runtime gets. Claude Code resolves its secure-storage scope from that
  variable _instead of_ `CLAUDE_CONFIG_DIR` whenever it is defined, and the empty
  value selects the unsuffixed service name — the entry a plain `claude /login`
  wrote — while Paddock's config dir stays exactly where it is. One variable, no
  home moved, nothing else shared. Set the variable yourself to a non-empty value
  and Paddock honours yours instead, saying so at startup.

  Also: the darwin Keychain probe #686 shipped flagged as unverified is now
  **confirmed correct** — the service name is exactly `Claude Code-credentials` —
  and the boot notice knows about the lever, so a found Keychain login under
  `credentials: host` is reported as the login being used rather than warned about
  as a login that cannot be seen.

- [#697](https://github.com/edspencer/paddock/pull/697) [`f9f6f12`](https://github.com/edspencer/paddock/commit/f9f6f126a69fed025fa2757fd73bcd09105b5d9b) Thanks [@edspencer](https://github.com/edspencer)! - `claude.instructions` and `claude.hooks` — your `~/.claude` prompts and hooks are
  no longer inherited unconditionally (#691 step 4).

  ```yaml
  claude:
    instructions: own # own | host — default own: CLAUDE.md, agents/, commands/, plugins/
    hooks: own # own | host — default own: the hooks key of settings.json
  ```

  Until now, relocating the Claude home was followed by symlinking the whole of
  your user-level config back into it — `settings.json`, `CLAUDE.md`, `agents/`,
  `commands/`, `plugins/` — with no key to turn any of it off. The half that
  matters is `hooks`: those are **shell commands** your `settings.json` binds to
  tool use and session lifecycle, and they ran inside every Paddock turn whether or
  not anyone chose that. "Isolate it by just trying Paddock" was not true, and this
  is why.

  **`hooks: own` is not a symlink decision.** `settings.json` carries `hooks` _and_
  `permissions`, `model`, `statusLine`, `enabledPlugins`; a symlink is
  all-or-nothing and the file is not. So Paddock writes its own `settings.json`
  into its Claude home carrying your other keys with `hooks` dropped. It is
  regenerated at every startup, so a restart is what applies an edit to yours —
  and only files that actually define hooks are copied at all, so most instances
  keep the symlink and nothing can go stale. A `settings.json` you put in Paddock's
  own home is recognised by hash and never overwritten; an unparseable source
  plants nothing rather than falling back to the symlink.

  **`instructions: own` is a deliberate reversal, and smaller than it looks.** The
  argument against it — shipped in #620's own docstring — is that your curated
  `~/.claude/CLAUDE.md` silently stops reaching your agents. Its premise turns out
  not to hold for the runtime Paddock runs chats on: user memory, `agents/` and
  `commands/` move with Claude Code's `user` setting source, which Paddock's agents
  do not load, so on a default chat turn these have been inert since chats moved to
  the SDK runtime. They do apply to the sweeper, triggers and `batch` chats. It is
  the default anyway because _"`own` everywhere means nothing outside the data dir
  is read or written"_ has to be a guarantee you can read off a config file, not a
  guarantee with a permanent footnote. Paddock names the key at startup when it
  finds files it is not loading; each project's own `CLAUDE.md` is unaffected.

  Both take `PADDOCK_CLAUDE_INSTRUCTIONS` / `PADDOCK_CLAUDE_HOOKS`, env > file >
  default, and both withdraw a symlink a previous `host` boot planted.

  **Scope, and a caveat found while building this.** `<claude-home>/settings.json`
  is Claude Code's `userSettings` source, and herdctl invokes the Agent SDK with
  `--setting-sources=project` for every agent that has a working directory — which
  is every Paddock agent. So a default chat turn never reads that file; the CLI
  paths (the sweeper, triggers, `driveMode: batch`) pass no such flag and do. The
  host's hooks therefore execute in those paths and not, today, in an SDK chat
  turn. Narrower than it looked, still real code execution, and the asymmetry is a
  herdctl default rather than a guarantee.

  Scope worth stating: `hooks: own` means _no host hooks_, not _no host commands_.
  `settings.json` has several other keys that name a script to run — `apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper`,
  `otelHeadersHelper`, `statusLine`, `subagentStatusLine` — and they are still
  inherited. Where they belong is an open question on #691.

- [#699](https://github.com/edspencer/paddock/pull/699) [`019a3ed`](https://github.com/edspencer/paddock/commit/019a3ed16ae4b4c45760c17643d9ff6a72e6e129) Thanks [@edspencer](https://github.com/edspencer)! - `claude.mcpServers` — your own MCP servers can now reach your Paddock agents
  (#691 step 5, the last of the five levers).

  ```yaml
  claude:
    mcpServers: own # own | host — default own
  ```

  `host` attaches the servers you added with `claude mcp add`: the top-level
  `mcpServers` of your `~/.claude.json` (user scope, every project) plus any under
  `projects.<absolute-dir>.mcpServers` (directory scope), which a project gets only
  when that directory is its own working directory. `own` (the default) attaches
  only what Paddock provides itself. Also `PADDOCK_CLAUDE_MCP_SERVERS`, env > file

  > default. The boot log names every server attached, and every one it could not
  > carry.

  **Why this key is not a symlink like the others.** MCP servers are not declared
  inside `~/.claude` at all — they live in **`~/.claude.json`**, a sibling _file_
  next to that directory, because Claude Code resolves it as
  `<config-dir-or-home>/.claude.json`. Once Paddock owns its own Claude home, no
  bridge of entries _inside_ the home can reach it, which is why MCP inheritance
  broke silently and separately from everything else. So `host` is a **read**:
  Paddock reads that file once at startup and passes the servers to the runtime. It
  deliberately does not symlink it, because Claude Code writes to it (per-project
  trust, server approvals, migration flags) and bridging it would mean a Paddock
  instance mutating your real config.

  Read once, at boot — add a server and restart Paddock to pick it up.

  **Two caveats found while building this, each warned about by name at startup.**
  The engine's MCP schema has fields for `command`, `args`, `env` and `url` only, so
  an http/sse server's **`headers` are dropped** (a bearer token is lost — and
  because MCP OAuth tokens are keyed on a hash of `{type, url, headers}`, its stored
  token is not found either), and **`type: sse` is connected to as HTTP**. A stdio
  server, which is most of them, is carried exactly. A server declaring neither a
  `command` nor a `url` is skipped.

  **MCP logins do follow `claude.credentials`** — an open question on #691, now
  answered from the bundled CLI: OAuth tokens live under an `mcpOAuth` key in the
  _same_ credential store as your Anthropic login, resolved by the same variable
  `claude.credentials` drives. There is no separate MCP token store, so
  `credentials: host` (the default) carries them and `credentials: own` means
  re-authorising inside Paddock.

  **Plugins are not covered, and #691's reasoning for why turns out to be wrong.**
  The design says the SDK does not auto-discover installed plugins; it does — the
  plugin root is the Claude home and discovery is real. What actually blocks it is
  that discovery is gated on `enabledPlugins` in the home's `settings.json`, which
  Paddock's agents never load (they run with only the _project_ setting source), and
  that herdctl exposes no way to pass a plugin per session. Both are outside this
  change. Until then a plugin's MCP server has to be declared directly with
  `claude mcp add`.

  Declaring a server _only_ for Paddock is still #691 step 6. Today:
  `CLAUDE_CONFIG_DIR=<data-dir>/claude-home claude mcp add …`, or a per-project
  `.mcp.json`.

- [#695](https://github.com/edspencer/paddock/pull/695) [`2fa6c80`](https://github.com/edspencer/paddock/commit/2fa6c809fd6cac9b280e5be516b2538afa0d14cb) Thanks [@edspencer](https://github.com/edspencer)! - A `claude:` block in `paddock.config.yaml`, and Paddock always owns its Claude
  home (#691, closes #690).

  Paddock had one lever — which Claude home it pointed at — and every distinct
  concern was welded to it: whose transcripts a delete removed, which login was
  visible, where agent memory was written. Three incidents in a week (#682, #683,
  #689) all came out of moving it for one reason and getting the other four for
  free. This splits the first concern out.

  ```yaml
  claude:
    transcripts: own # own | host — default own
  ```

  `own` (the default) is today's behaviour: transcripts live in each project's
  `.chats/`, inside the data dir, and nothing outside it is written. `host` shares
  your real `~/.claude/projects/<encoded-cwd>/` folder live in both directions — a
  chat continued in a terminal with `claude --resume` shows up in Paddock with no
  restart and no re-import. Deleting a chat under `host` **releases** it rather
  than removing it (#689): the transcript is your history, not Paddock's copy.
  `PADDOCK_CLAUDE_TRANSCRIPTS` overrides the file, as usual.

  `host` is one symlink per project pointing _out_ of Paddock's own Claude home,
  not a repointed `CLAUDE_CONFIG_DIR`. That is what fixes **#690**: agent memory
  lives at `<claudeHome>/projects/<enc>/memory`, and an agent cannot write to any
  path containing a `.claude` component — so 0.61.1's "share by pointing the home
  at `~/.claude`" silently took agent memory away. Here the literal path stays
  inside Paddock's own home in both modes; only what it resolves to changes.

  **Breaking, deliberately and without a compatibility shim:**

  - **`CLAUDE_HOME` is deleted.** It is ignored, not an error (retired settings are
    never fatal), so a stale export cannot move the home back on top of yours.
  - **`--isolated-claude-home` is deleted.** It opted out of something Paddock no
    longer does.
  - **`CLAUDE_CONFIG_DIR` is still honoured** as "put Paddock's own home here" —
    it is Claude Code's own variable and herdctl declines to clobber an
    operator-set value — but Paddock now **refuses to start** if it (or a
    `claudeHome:` key) resolves to your own `~/.claude`. That is the single value
    that re-welds every concern together and re-breaks agent memory; the refusal
    names `transcripts: host` as what you probably wanted.

  Existing instances need no migration: transcripts already live in each project's
  `.chats/`, so moving the home moves no data — the first boot replants each
  project's symlink in the new home aimed at the same directory. Verified by
  running an instance of each version against copies of one real fixture: chat
  lists, adoptable counts, message bodies and `.chats/` content hashes were
  identical, and the only difference on disk was the replanted links.

- [#701](https://github.com/edspencer/paddock/pull/701) [`83d661f`](https://github.com/edspencer/paddock/commit/83d661f7d8b82e559ba8e2b678b030e76bdda0b8) Thanks [@edspencer](https://github.com/edspencer)! - `mcpServers:` — declare an MCP server to Paddock itself (#691 step 6, the last of
  the sequence).

  ```yaml
  mcpServers:
    notion:
      command: npx
      args: ["-y", "@notionhq/notion-mcp-server"]
      env:
        NOTION_TOKEN: env:NOTION_TOKEN # a reference, not the token
  ```

  Until now there was nowhere to say this. `claude.mcpServers: host` borrows the
  servers your machine already has, which is no help if you are running Paddock in
  a container and want Notion in it — there is nothing on the host to borrow. So
  this is a **sibling of `claude:`, not a key inside it**: that block asks _whose_
  servers this instance uses, this one says what it should have regardless.

  Every project's keeper gets every server declared here, and each one's
  `mcp__<name>__*` pattern is added to that keeper's tool allow-list — without
  which the server attaches and then has every call silently refused. The boot log
  names each attached server.

  **Precedence** is `claude.mcpServers: host` < `mcpServers:` < Paddock's own. A
  name you declare beats the same name inherited from `~/.claude.json`, because
  this file is a statement about _this instance_ and that one is ambient machine
  state. Paddock's own still win: `paddock` and `paddock_manage` are reserved
  names, and a `playwright` of yours loses to the built-in browser server — with a
  warning at boot rather than in silence.

  **Keeping the token out of the file.** `paddock.config.yaml` is git-tracked and
  the Config screen writes to it, so anywhere a string is expected — `command`, an
  `args` entry, an `env` value, `url` — **`env:VAR_NAME` reads that value from the
  environment**, the same indirection `managementApi` already uses for its client
  tokens. An unset variable **drops that server** with a warning naming the
  variable, rather than starting it without its credential. An inline value is
  still allowed (an MCP `env` entry is often not a secret) but a credential-shaped
  key, or a `url` with a query string, is warned about. Nothing Paddock logs or
  serves ever contains a value from this block, and it is deliberately absent from
  the Config screen and every API response.

  **A declaration Paddock cannot carry faithfully is refused, not degraded** —
  `headers:`, `type: sse`, an unrecognised key (`arg:` for `args:`), or both/neither
  of `command` and `url`. That is the opposite of how `claude.mcpServers: host`
  treats the same problems, deliberately: a host server was configured elsewhere
  for something else, while this one you typed at Paddock and can fix. Only the
  offending server is dropped; the rest attach and the instance boots.

  Also fixes a gap in the previous release: the Config screen showed four of the
  five `claude:` levers and not `claude.mcpServers`. It is now listed, read-only,
  alongside its siblings.

### Patch Changes

- [#692](https://github.com/edspencer/paddock/pull/692) [`4c510ff`](https://github.com/edspencer/paddock/commit/4c510ff7dab14f1f144fa069d92345310c39cba7) Thanks [@edspencer](https://github.com/edspencer)! - Deleting a chat no longer destroys a transcript Paddock does not own (#689).

  With the Claude home pointed at the user's own `~/.claude`, `DELETE /chats/:id`
  returned `{"ok":true,"removed":true}` and unlinked the user's terminal `claude`
  history for that directory. There is no copy to fall back on — Paddock plants no
  symlink in a home it does not own (#682), so the file the agent reads and writes
  _is_ the user's. It is #682 pointed the other way: that one claimed where future
  sessions get written, this one deleted the past ones.

  Delete now releases the session in that case instead of removing it, and the
  response carries `retained: true`. In a home Paddock owns the behaviour is
  unchanged — the transcript is Paddock's own copy in the project's `.chats/`, and
  delete still means delete.

  Known gap, tracked in #689: a released chat is still listed, because a chat
  Paddock created is rediscovered by scanning the home. Closing that needs a
  tombstone, which is deferred to the `transcripts` mode work in #691 rather than
  built against a flag that design removes.

## 0.61.1

### Patch Changes

- [#686](https://github.com/edspencer/paddock/pull/686) [`3f63720`](https://github.com/edspencer/paddock/commit/3f63720a70b9fd73cff52bd3e4cc8a33a809c7ef) Thanks [@edspencer](https://github.com/edspencer)! - The `paddock` CLI now uses the Claude Code login you already have, including on
  macOS (#683). With no `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` and no explicit
  `CLAUDE_HOME`/`CLAUDE_CONFIG_DIR`, it runs against your own `~/.claude` instead of an
  isolated home under the data dir.

  Since #620 Paddock always set `CLAUDE_CONFIG_DIR`, and Claude Code derives its
  secure-storage service name from whether that variable is set at all — so a Keychain
  login made under the plain name became invisible. The `.credentials.json` bridge
  covers the file-based store and is structurally incapable of covering macOS. The
  result was `npx @edspencer/paddock --here` booting fine and failing every turn with
  `Not logged in`, on the platform the npx story is aimed at.

  Continuity means transcripts stay in `~/.claude/projects/` rather than being relocated
  into the workspace's `.chats/`. Paddock still writes nothing there (#682), and import
  consent is unchanged — existing sessions are offered, not opened, exactly as before.
  Pass `--isolated-claude-home` for the previous behaviour; a server, the container image
  and `node dist/index.js` are unchanged.

  Also: on macOS, when Paddock does hold its own home and finds no credential, it now
  probes the Keychain and — if a login is there — says so and gives the exact command,
  instead of a generic "no credentials found". The secret is never read or copied.

- [#685](https://github.com/edspencer/paddock/pull/685) [`5fee9ee`](https://github.com/edspencer/paddock/commit/5fee9ee1ccfc15f18fc58dcb1d5eba67b1f7b749) Thanks [@edspencer](https://github.com/edspencer)! - Never plant a transcript symlink in a Claude home Paddock does not own (#682).
  `ensureProjectChats` gated its two existing-directory branches on `home.owned` but
  not the "nothing there yet" one, so with `CLAUDE_HOME=~/.claude` a directory with no
  prior transcripts got `~/.claude/projects/<encoded-cwd>` replaced by a link to the
  workspace's `.chats/`. From then on every `claude` session started in that directory
  was written into Paddock's store, and deleting that store — an ordinary thing to do —
  destroyed transcripts Paddock never owned. Reported on a real laptop: 30 sessions lost.

  Paddock now creates nothing in an unowned home; transcripts stay where Claude Code
  writes them and adoption remains the user-driven way to import them. Boot also warns
  about links an affected build already planted, naming each path. Nothing is deleted
  automatically — Paddock does not write to `~/.claude`, and that has to include
  cleaning up after itself.

- [#680](https://github.com/edspencer/paddock/pull/680) [`fee480a`](https://github.com/edspencer/paddock/commit/fee480a76027ffd4aa1caa302df947436f57a7a2) Thanks [@edspencer](https://github.com/edspencer)! - Correct `paddock --help`: `--here` does not link `~/.claude`. #665 fixed the two
  runtime `console.log` strings but missed the `USAGE` block, which still claimed the
  flag "links `~/.claude/projects/<encoded-dir>` at this workspace". Since #620/#634 the
  Claude home defaults to `<dataDir>/claude-home` and `transcripts.ts` bails before
  planting a symlink in a home Paddock does not own — sessions are _offered_ for import
  and nothing is moved, copied or linked until you confirm (#663).

- [#687](https://github.com/edspencer/paddock/pull/687) [`194dfc2`](https://github.com/edspencer/paddock/commit/194dfc295636dbb12893442c7d44407b558050bf) Thanks [@edspencer](https://github.com/edspencer)! - A credential-less first run no longer greets you with a stack-trace wall (#684).

  `npx @edspencer/paddock --here` with no token printed a multi-screen dump containing
  the entire sweeper system prompt four times — in the `ExecaError`, in the
  `[fleet-manager]` line, in the serialised `err.message` and again in `err.stack`. The
  one useful string, `Not logged in · Please run /login`, was on line 40. The server was
  fine and still serving; nothing in the output said so.

  - The sweeper recognises "not logged in", "out of credit" and "no `claude` on PATH"
    and logs one actionable warn line with no error object to serialise. An
    unrecognised failure keeps its full detail.
  - The `claude` argv is cut out of `@herdctl/core`'s agent-failure lines, taking the
    2 KB system prompt with it. `HERDCTL_LOG_LEVEL=debug` restores it.
  - The CLI's quiet mode now actually covers failures. `LOG_LEVEL=warn` never could:
    these are logged at `error`, above every threshold either variable can set.

  Measured on the repo's own test-suite log: eight copies of the curator system prompt
  before, zero after.

## 0.61.0

### Minor Changes

- [#634](https://github.com/edspencer/paddock/pull/634) [`4df3a7a`](https://github.com/edspencer/paddock/commit/4df3a7a2ef6358c6e41a480eddf1add8d9ed31e4) Thanks [@edspencer](https://github.com/edspencer)! - Paddock now owns its Claude home; `~/.claude` is a read-only source (#620)

  Claude Code's transcripts were the one piece of state Paddock did not keep under
  its own data dir. They lived in the user's `~/.claude`, reached by planting
  symlinks into it from outside — and `ensureProjectChats` would, on every agent
  registration and inside a bare `catch {}`, copy a user's existing transcripts out
  of there and **delete the originals**. That fired in exactly the case the chat
  import (#588) exists to serve: pointing a project at a directory you already have
  terminal `claude` history for.

  That layout was forced, not chosen: until herdctl#423 nothing set
  `CLAUDE_CONFIG_DIR`, so the SDK wrote to `~/.claude` whatever home Paddock
  configured. With `@herdctl/core@5.29.0` that constraint is gone.

  - The Claude home now defaults to **`<dataDir>/claude-home`**, making a data dir
    movable, backable and wipeable as a unit. Precedence is `CLAUDE_HOME`, then
    `CLAUDE_CONFIG_DIR`, then a `claudeHome:` config-file key, then the default.
  - **Paddock never moves or deletes anything under `~/.claude`.** The destructive
    migrate branch is gated on owning the home, so in the user's home it does
    nothing at all.
  - **Chat import still reads `~/.claude`** — the user's transcript folders are
    mirrored into Paddock's home read-only, so a source is copied out of and never
    written to.
  - **Agent memory writes work.** Claude Code keeps per-project memory at
    `<claudeHome>/projects/<enc-cwd>/memory/`; with no `.claude` path component the
    harness restriction that blocked writes there no longer applies.
  - User-level config in `~/.claude` (`.credentials.json`, `settings.json`,
    `CLAUDE.md`, `agents/`, `commands/`, `plugins/`) is symlinked into the new home
    when it has none of its own, so relocating does not drop your memory,
    permissions or login.

  **No data migration is required or performed.** Paddock-managed transcripts
  already live in `<projectDir>/.chats/`; only the redirect symlink moves. The
  symlinks a previous version planted in `~/.claude/projects/` are left in place
  (nothing reads them any more) and reported once at boot so they can be cleaned up.

  **Upgrading with a keychain-based login:** Claude Code scopes its credential store
  to whether `CLAUDE_CONFIG_DIR` is set, so a login held in the OS keychain against
  the default home is not found under the new one. Token-in-environment setups
  (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) and file-based logins are
  unaffected — the latter are bridged. Paddock warns at boot when it can find no
  credential source, and `CLAUDE_HOME=$HOME/.claude` restores the previous layout
  exactly.

### Patch Changes

- [#675](https://github.com/edspencer/paddock/pull/675) [`38fe841`](https://github.com/edspencer/paddock/commit/38fe841c4b8e49b52694b69026a05350ea2eec83) Thanks [@edspencer](https://github.com/edspencer)! - Stop destroying appended queued text when the enqueue timestamp is reused (#628)

  The server's queue drain deduped a queued message on its client-supplied
  `createdAtMs` alone. The client deliberately KEEPS that timestamp when appending
  to an existing queue, so the message identity stays stable (#245) — which meant a
  pane holding an already-drained queue (it never saw the un-buffered
  `chat:queued_flushed` clear) re-asserted the same timestamp with longer text, and
  the next drain treated it as a duplicate: it broadcast a text-less clear and threw
  the appended text away. Not delayed — gone.

  Drain now dedups on the `(ts, text)` tuple. A re-assert of the exact same message
  is still a duplicate (so #245's no-double-send guarantee is unchanged), but "same
  ts, different text" is correctly recognised as a new message and sent.

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

- [#675](https://github.com/edspencer/paddock/pull/675) [`38fe841`](https://github.com/edspencer/paddock/commit/38fe841c4b8e49b52694b69026a05350ea2eec83) Thanks [@edspencer](https://github.com/edspencer)! - Make Stop work on slash-command turns (#632)

  Pressing Stop during a `/compact` did nothing — permanently. Two wiring gaps:
  `onChatCommand` hardcoded `jobId: null` in its routing, so no turn id ever
  reached the client (whose cancel is guarded by `if (meta.jobId)`, and whose
  deferred pre-arm cancel therefore waited forever); and `runCommand` never
  registered its session in `liveSessions`, so even a hand-supplied id resolved to
  nothing to interrupt. Since compaction runs 60–180s, that is a long stretch with
  no way out.

  `runCommand` now mints a synthetic turn id, registers the live session under it
  exactly as `chatSession` does (and deregisters it in the same `finally` that
  closes the session), and hands it back via `onJobCreated`; `onChatCommand` puts
  that id in its routing. `chat:cancel` on a command turn now reaches
  `RuntimeSession.interrupt()`.

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

- [#665](https://github.com/edspencer/paddock/pull/665) [`1e03494`](https://github.com/edspencer/paddock/commit/1e03494ef7a610b7b97cc0659733ed3b41d526bd) Thanks [@edspencer](https://github.com/edspencer)! - CLI: tell the truth about `--here` and stop double-warning about credentials

  `--here` no longer links the user's `~/.claude` transcripts into the workspace —
  since #620/#634 `ensureProjectChats` bails out inside a home Paddock does not own,
  so those sessions are left exactly where they are and surface as an _import offer_
  (which since #663 also asks for confirmation). Two consent strings still described
  the old behaviour and now describe the real one.

  The `npx paddock` preflight also printed its own "No Claude credentials found"
  warning immediately before the boot-time one from `ensureClaudeHome`. The
  preflight checked the _legacy_ `~/.claude` rather than the home Paddock actually
  uses, and treated a bare `~/.claude.json` as proof of a login — so it could stay
  silent while Paddock's own home held no credentials at all. It is removed; the
  boot notice checks the right directory, runs after the credential bridge, and
  explains the `CLAUDE_CONFIG_DIR` keychain scoping that causes the failure.

- [#676](https://github.com/edspencer/paddock/pull/676) [`1bbba15`](https://github.com/edspencer/paddock/commit/1bbba15bbbd64a3e5b795684b4c8d6fca62ef589) Thanks [@edspencer](https://github.com/edspencer)! - Paddock is MIT licensed, and the packaging script now proves it (#674)

  The repo had no `LICENSE` file and no `license` field in any manifest — legally,
  all rights reserved — while `scripts/make-npm-package.mjs` carried a
  `license: serverPkg.license ?? "MIT"` fallback, so every published release told
  npm it was MIT. The registry advertised a grant the source never made.

  Now there is a real `LICENSE` (MIT, © 2026 Ed Spencer) at the repo root,
  `"license": "MIT"` in the root, server, and web manifests, and the licence text
  ships inside the published tarball and the release tarball. The fallback is
  gone: the packaging script reads the real field and **exits non-zero** if it is
  missing or blank, so a Paddock package can never again claim a licence the repo
  did not grant.

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

- [#663](https://github.com/edspencer/paddock/pull/663) [`59aa52f`](https://github.com/edspencer/paddock/commit/59aa52f4a0aad1d0436efcfa389c459f912ca795) Thanks [@edspencer](https://github.com/edspencer)! - Stop offering Paddock's own sweeper runs as native chats to import

  The "Import N native chats" button could offer back the sweeper's own curation
  transcripts. On the dogfooding instance, 10 of the 26 chats the `paddock`
  project offered were Paddock's output, not the user's terminal history.

  The sweeper is a one-shot `claude -p` subprocess, so it writes an ordinary
  transcript into the project's own chat folder. Adoption relies on the engine's
  attribution to exclude "sessions a real Paddock run owns", and attribution is
  driven by run records — but no `job-*.yaml` binds those ten session ids. With no
  run record, a sweeper transcript is indistinguishable from a session the user
  typed in a terminal, so it was offered for import.

  Curation runs are now recognised by their prompt's opening (the
  `Project: <name> (slug: <slug>)` header plus the `You are curating` sentence) and
  withheld under a new `sweeper-run` filter reason. Like the existing `too-small`
  and `slash-command-only` reasons they are reported in `filtered` rather than
  dropped silently, so the count always has an explanation.

  The rule is asserted against the prompt `SweepService` really builds, not a copy
  of it — the wording has drifted once already ("curating two files in this project
  directory" → "curating this project's three context files"), and a stale copy
  would have let the filter drift with it.

- [#663](https://github.com/edspencer/paddock/pull/663) [`59aa52f`](https://github.com/edspencer/paddock/commit/59aa52f4a0aad1d0436efcfa389c459f912ca795) Thanks [@edspencer](https://github.com/edspencer)! - Only offer a same-named directory for import if it really is a clone of the repo

  For a repo-backed project, the import offer matched any transcript folder whose
  recorded working directory had the same BASENAME as the project's checkout —
  anywhere on disk. On the dogfooding instance the `hushpod` project was
  consequently offering 15 chats out of
  `/data/scratch/paddock-video/data/projects/hushpod`: a throwaway QA instance's
  data directory, matched purely on leaf name and belonging to a different Paddock
  instance entirely.

  A same-named directory now has to prove it is a clone of the project's repo. Its
  git remotes are compared against `project.repo`, normalised so that the same repo
  addressed different ways still matches:

      https://github.com/acme/api.git  ┐
      git@github.com:acme/api          ├─ all → github.com/acme/api
      ssh://git@github.com/acme/api/   ┘

  Any configured remote counts, not just `origin`, so a contributor whose `origin`
  is their fork and whose `upstream` is the project's repo still matches. Linked
  worktrees are handled (`.git` is a file; the config lives in the main repository's
  git dir behind a `commondir` pointer).

  The original reason for not checking the remote was cost — running git in every
  candidate directory, behind a count rendered in a header. Nothing shells out
  here: the remote is read from `.git/config`, only for directories that already
  passed the basename test, memoised on that file's mtime and size.

  A candidate with no readable git config, or whose remotes all point elsewhere, is
  no longer offered. The project's own working directory is exempt and always
  offered, so a project whose checkout has an unusual remote keeps its own history.

- [#662](https://github.com/edspencer/paddock/pull/662) [`63acc1e`](https://github.com/edspencer/paddock/commit/63acc1e8436c873ce038f587fdf7bee2f7f201e1) Thanks [@edspencer](https://github.com/edspencer)! - Fix Stop being a permanent no-op while a chat runs background work (#528)

  A chat could sit with the spinner and the **Stop** button showing forever. Stop
  did nothing — no error, no frame, no log line. The composer silently queued
  anything typed instead of sending it, and reloading didn't help because the state
  is server-authoritative and replays as running. Only restarting the server
  cleared it.

  Two independent things had to be wrong at once, and both were.

  **The turn had no cancellable identity.** Once a session-mode turn's primary
  `result` lands, the session can stay open — the reaper holds it while the turn's
  background work runs — and autonomous re-invocation turns keep arriving on the
  same stream. Paddock renders that stretch through `makeBackgroundTurnSink`, which
  opened its hub turn and never called `setJobId`. `setJobId` was being called at
  only two of the five turn-start sites, and this was one of the three that missed,
  so every frame and every `chat:active` carried `jobId: null`. The client's
  deferred-cancel (#196) waits for a jobId that never arrives, so clicking Stop put
  **nothing on the wire at all** — which is why it failed silently rather than
  erroring. The sink now mints a synthetic job id and publishes it the moment the
  turn opens, exactly as the foreground path does via `onJobCreated`.

  **Nothing it could route to.** `HerdctlService.cancel` knew two kinds of id: a
  live turn in `liveSessions` (→ `session.interrupt()`) and a batch job (→
  `cancelJob`). The primary turn's `liveSessions` entry is deleted the moment it
  returns, so a background-phase id matched neither and fell through to
  `cancelJob(<synthetic uuid>)` → `JobNotFoundError` → `false`, discarded by the WS
  layer. `interrupt()` would have been wrong anyway: it targets an in-flight model
  turn, and this session is idle, holding background work. Cancel now routes these
  to `fleet.reapChatSession()` (new in `@herdctl/core` 5.31.0) — end the session,
  let the stream end, and let the existing unwind emit `chat:complete` and unlock
  the UI.

  The wedge is easiest to hit on a **subscription usage limit**: sub-agents die, the
  parent's re-invocation turn dies without a Stop hook, and the reaper's
  `awaitingTasks` state (cleared by that turn's `activity`) means no later signal
  can ever reap the session. It also covers the originally reported trigger — a
  model-authored `until` loop whose sentinel never arrives, so the background task
  set never drains.

  Requires `@herdctl/core` ≥ 5.31.0.

## 0.59.1

### Patch Changes

- [#654](https://github.com/edspencer/paddock/pull/654) [`98d1239`](https://github.com/edspencer/paddock/commit/98d12396901ad5b86cbbe5567c6a23bcea736243) Thanks [@edspencer](https://github.com/edspencer)! - Fix `npx @edspencer/paddock` doing nothing at all

  **0.57.0, 0.58.0 and 0.59.0 shipped a CLI that printed nothing and exited 0.**
  Any invocation through npm — `npx @edspencer/paddock`, or a global install —
  was a silent no-op. Running the file directly with `node` worked, which is why
  it escaped notice.

  The cause was the run-directly guard introduced in #638 so that unit tests could
  import the entrypoint without executing it:

  ```ts
  if (pathToFileURL(process.argv[1]).href === import.meta.url) main();
  ```

  npm installs a `bin` as a **symlink** at `node_modules/.bin/paddock`, so
  `process.argv[1]` is the link path while `import.meta.url` is the module's
  realpath. The two never match, so `main()` never ran.

  `realpathSync(argv[1])` would have fixed that one instance. Instead the pure
  parts (`parseArgs`, `nodeVersionProblem`, `explainListenError`, `USAGE`) move to
  `cli/args.ts`, which is importable without side effects, and `paddock.ts` now
  **always** runs. There is no condition left to get wrong on the next shim,
  platform or package manager.

  Guarded by a new integration test that spawns the entrypoint **through a
  symlink** — the invocation shape every earlier check missed. Verified to fail
  against the old code and pass against the new.

## 0.59.0

### Minor Changes

- [#651](https://github.com/edspencer/paddock/pull/651) [`8a22477`](https://github.com/edspencer/paddock/commit/8a224771084109cfe7d4e34c1fe1058793ce5ed2) Thanks [@edspencer](https://github.com/edspencer)! - `paddock --here` — open the current directory as a workspace (#640)

  ```sh
  cd ~/code/myapp
  npx @edspencer/paddock --here
  ```

  Paddock opens **that directory** as its workspace: Claude works in your files,
  and the Claude Code sessions you already have for the directory are offered for
  import.

  **This needed no new concept.** A _project_ cannot live outside `projectsRoot`,
  but the **root workspace** is a different thing — its key is `""`, so
  `dirFor("")` resolves to `projectsRoot` itself, and `projectsRoot` is already
  user-configurable. Session adoption then matches by construction, because
  `AdoptableIndex`'s notebook branch is exact `cwd === workingDir` equality and
  here the workspace's working directory IS your cwd.

  **A bare `npx @edspencer/paddock` still touches nothing.** It starts the server
  against `~/.paddock` as before. If the directory you happen to be in has Claude
  sessions, it says so and names the flag — read-only, nothing written.

  **The flag is the consent.** No prompt, no `--yes` to remember. Because consent
  means nothing if you cannot know what you agreed to, `--here` _announces_ what it
  does on the run that does it: creates `.paddock/` (this workspace's own state)
  and `.chats/`, adds both to `.gitignore` (appending — your rules are preserved),
  and links `~/.claude/projects/<encoded-dir>` at the workspace.

  **Later runs in that directory resume it with no flag** — the `git` model, where
  `--here` is `git init` and `.paddock/` is `.git`. `.paddock/` was chosen over
  `project.yaml` as the marker precisely because it is unambiguous: `project.yaml`
  already exists in the wild and would make unrelated directories auto-adopt.

  State lives in `<dir>/.paddock` rather than the shared `~/.paddock`, so opening
  two directories does not have them share one job store and leak each other's run
  history.

  Every run now names its workspace on startup — behaviour that varies with cwd is
  only safe if it is observable.

## 0.58.0

### Minor Changes

- [#650](https://github.com/edspencer/paddock/pull/650) [`2c625b9`](https://github.com/edspencer/paddock/commit/2c625b98c3cb552549ce6a0272eb48b9e869ffba) Thanks [@edspencer](https://github.com/edspencer)! - Make the `paddock` CLI usable by someone who has never seen it (#638)

  - **`--open`** launches the browser once the server is listening.
  - **Quiet by default.** A first run printed ~30 lines of boot logging, scrolling
    the URL off the top of the terminal; it now prints 9, all of them meaningful.
    This needed **two** unrelated loggers told to hush — `LOG_LEVEL` for Paddock's
    pino logger and `HERDCTL_LOG_LEVEL` for `@herdctl/core`, which emits its
    `[fleet-manager] …` lines through `console.info` where pino's level cannot
    reach them. **`--verbose`** opts back in, and an explicit value for either
    variable is always respected.
  - **`EADDRINUSE` and `EACCES` are explained**, not dumped. Port 4000 is popular
    and is also Paddock's default, so "address in use" is the likeliest first-run
    failure; the message now names the port and suggests `--port <n+1>`.
  - **`--help` documents where your data lives** — that it is one directory, that
    it persists, and that moving or deleting it moves or resets the instance.

  Also fixes a latent bug in `import-chats`: its run-directly guard compared
  `import.meta.url` against `"file://" + process.argv[1]`, which leaves spaces and
  non-ASCII characters un-encoded, so the script would silently do nothing when run
  from such a path (the same trap as #636).

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

- [#643](https://github.com/edspencer/paddock/pull/643) [`b5fa1be`](https://github.com/edspencer/paddock/commit/b5fa1be5e8e02eafdeb1833d44f5aa40aac65cc3) Thanks [@edspencer](https://github.com/edspencer)! - Publish Paddock to npm as `@edspencer/paddock` — `npx @edspencer/paddock` (#637)

  Paddock is now installable without Docker and without a clone:

  ```sh
  npx @edspencer/paddock
  ```

  The published package is **synthesized**, not a workspace package.
  `scripts/make-npm-package.mjs` stages a single public package from the built
  output; `@paddock/server` and `@paddock/web` stay `private` and unrenamed, so no
  future `npm publish` in this repo can fire an internal-named package at the
  registry by accident.

  Two deliberate divergences from the repo tree: **sourcemaps are stripped** (files
  and `sourceMappingURL` comments — 15 MB of the 19 MB web dist, for something an
  end user of a packaged app never opens; 2.0 MB packed vs ~22 MB with maps), and
  **dependencies are pinned** to the versions in `package-lock.json`, because a
  lockfile does not travel with a published package and a caret would hand `npx`
  users a `@herdctl/core` minor that CI never saw.

  Releases publish via **OIDC trusted publishing** with provenance attestation —
  no `NPM_TOKEN` secret exists, and the job fails the release if the attestation
  does not appear.

  Also corrects a long-standing docs claim: `CONTRIBUTING.md`, `DEV.md` and
  `CLAUDE.md` all listed the `claude` CLI as a flat prerequisite. Chats do not need
  it — they run herdctl's SDK runtime, which resolves the Claude Agent SDK's own
  bundled binary and never consults `PATH`. Only the sweeper, triggers and
  `driveMode: batch` shell out to `claude`.

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

### Patch Changes

- [#639](https://github.com/edspencer/paddock/pull/639) [`66ccfe8`](https://github.com/edspencer/paddock/commit/66ccfe8861c293c920f3f5c9ace5270e30dfe399) Thanks [@edspencer](https://github.com/edspencer)! - Decode the web-dist module path with `fileURLToPath` (groundwork for `npx`)

  `config.ts` derived the default location of the built SPA from
  `new URL(import.meta.url).pathname`. That pathname is percent-**encoded**, so
  any install path containing a space or a non-ASCII character — `/opt/my
paddock/`, `~/Développement/paddock/` — resolved `packages/web/dist` to a
  directory with a literal `%20` in it, which does not exist.

  The failure was **silent**. `app.ts` treats a missing dist as "API-only mode"
  and logs a warning, so the symptom was a blank page at `/` with nothing in the
  UI explaining why, while `/api/health` kept returning `{"ok":true}`.

  This never bit the Docker image, whose path is a fixed `/app`, and it does not
  affect any instance that sets `PADDOCK_WEB_DIST` explicitly. It becomes
  load-bearing the moment Paddock is installed under an arbitrary user directory,
  which is exactly what `npx` / `npm i -g` will do. `fileURLToPath` also decodes
  the `/C:/…` drive-letter form on Windows.

  The resolution now lives in an exported `resolveDefaultWebDist(moduleUrl)` so it
  can be tested against install paths this repo's own checkout does not have.

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

### Patch Changes

- [#579](https://github.com/edspencer/paddock/pull/579) [`21e4c95`](https://github.com/edspencer/paddock/commit/21e4c9500c5f0043e1a799dc650c8fb4be452584) Thanks [@edspencer](https://github.com/edspencer)! - Auth no longer exempts five unregistered health paths (`/healthz`, `/-/health`, `/health`, `/readyz`, `/livez`)

  Only `/api/health` was ever a registered route. The other five were exempt from
  authentication but served by nothing, so with the SPA mounted they fell through to
  the front-end catch-all and answered `200 text/html` — the app shell — to an
  unauthenticated probe. A monitoring check pointed at `/healthz` therefore reported
  healthy regardless of the instance's actual state, and in `trusted-header`/`jwt`
  mode the exemption inverted the truthful answer (an unknown path 401s; these did
  not).

  **Operator action:** point every liveness/readiness probe at **`/api/health`**,
  which returns `200 {"ok":true}` as `application/json`. The shipped `Dockerfile`
  HEALTHCHECK and the Kubernetes manifests already use it, so no in-tree deployment
  changes. The five retired paths are now gated like any other unknown path. `AUTH.md`
  and the website's authentication page previously documented all six as exempt and
  have been corrected.

- [#602](https://github.com/edspencer/paddock/pull/602) [`d8f8764`](https://github.com/edspencer/paddock/commit/d8f8764b1dd1d66542f55871323f47f091812729) Thanks [@edspencer](https://github.com/edspencer)! - Two measured memory fixes on the hot read paths: the jobs index stops retaining
  whole YAML documents, and `/chats/usage` stops opening a file per chat at once.

  **The jobs index was holding every record body it exists to avoid holding
  (#543).** `JobsDirIndex` keeps three small fields per `job-*.yaml` —
  `session_id`, `finished_at`, `agent` — and its own docs promise "one ~100-byte
  tuple per record, never the 24.5 KB average record body". That promise was
  false. The `yaml` parser builds scalars by slicing the document text, and V8
  represents those slices as SlicedStrings that pin the ENTIRE source string
  alive, so caching a scalar verbatim retained the whole record.

  Measured against this instance's jobs dir (2,016 records, 2,012 indexed),
  driving the real index rather than a replica: **95.7 MB retained before, 1.9 MB
  after** — ~94 MB off RSS for three `detachString` calls. Cold scan (1,175 vs
  1,187 ms) and warm scan (38 vs 29 ms) are unchanged; this is a pure copy with
  no semantic surface. Core hit the identical bug in its own job index and fixed
  it the same way, so this matches that implementation rather than inventing a
  variant.

  **`/chats/usage` fanned out unbounded (#544).** The route mapped over every
  session with `Promise.all`, so a project with 1,515 chats started 1,515
  transcript reads at the same moment. The work is identical either way — the
  reads just all land in memory at once instead of a few at a time. Bounded at
  16, measured on that corpus against the real usage path, one cold process per
  setting:

  | concurrency       | peak RSS |
  | ----------------- | -------- |
  | unbounded (1,515) | 1,025 MB |
  | 64                | 646 MB   |
  | 32                | 555 MB   |
  | 16                | 522 MB   |
  | 8                 | 375 MB   |

  **Peak RSS halves.** The results do not change: the bounded and unbounded maps
  were diffed over all 1,515 chats and produce the same order and the same 460 KB
  of serialised usage, which is the property the endpoint actually depends on
  (callers index the result positionally).

  Two figures in the design note behind this work did not reproduce and are
  corrected here rather than repeated: the win is 2×, not the 4× estimated
  against a standalone replica (the real path also reads each chat's sub-agent
  transcripts, lifting both floor and ceiling), and "16 is _faster_ than
  unbounded" is not supportable — wall time varies 6.5–14.9 s for both settings
  on this box, so the honest claim is no measurable latency cost.

  The bound is a named constant in a new `concurrency.ts` because the planned
  boot-warm sweep needs the same one. It is a local copy only because
  `@herdctl/core` defines this helper twice and exports neither from its package
  root; when herdctl#421 lands, this module should be deleted and the import
  repointed at core.

- [#623](https://github.com/edspencer/paddock/pull/623) [`8480cb6`](https://github.com/edspencer/paddock/commit/8480cb60fe45986aedea4905f695d84640744e0d) Thanks [@edspencer](https://github.com/edspencer)! - Keep the running sub-agents bar alive when you navigate away from a chat and back (#622).

  Re-opening a chat rehydrates it from history, and the history join left a
  still-running `Task`/`Agent` launch unenriched — no `toolUseId`, no
  `hasSubagent` — because it has no `tool_result` yet. The bar's candidates need
  both, so it emptied for the rest of the sub-agent's run and its cards stopped
  being expandable, self-healing only once the sub-agent finished. In-flight
  launches are now joined off their own cursor, so they enrich like the live
  `chat:tool_start` path does while completed sub-agents keep their exact
  positional alignment.

- [#625](https://github.com/edspencer/paddock/pull/625) [`a18ceb2`](https://github.com/edspencer/paddock/commit/a18ceb2b048693523c7c263371903d97f2b765fa) Thanks [@edspencer](https://github.com/edspencer)! - Make the self-MCP read tools honest about what they drop, and point callers at the raw transcript (#615).

  `read_chat`'s description now states the thing that surprises every caller:
  `role: "tool"` entries come back with **empty** text — no tool name, input or
  output — and they still count against `limit`, so on a tool-heavy chat most of
  the reply is blank padding. Thinking blocks, attachments and sub-agent
  transcripts are dropped outright. It also says what the tool is therefore _not_
  for (auditing how a chat went) and where the lossless data lives:
  `<data-dir>/projects/<slug>/.chats/<sessionId>.jsonl`, sub-agents under
  `<sessionId>/subagents/agent-*.jsonl`.

  It also flags a silent footgun: an unknown `session_id` returns `total: 0` with
  no error. A nightly reviewer hit exactly this, mistyped one id, and published
  "empty chat" about a conversation it had never opened.

  `list_chats` now says that `name` falls back to an 8-character `sessionId`
  prefix when a chat has no stored title — that it means _untitled_, and is not a
  usable id.

  Descriptions and docs only; no behaviour change.

- [#580](https://github.com/edspencer/paddock/pull/580) [`a8c37d8`](https://github.com/edspencer/paddock/commit/a8c37d852ccf8aa0d970ff3407890de391fd4e6d) Thanks [@edspencer](https://github.com/edspencer)! - The self-management MCP surface can now see and reach the **root workspace**
  (#560). Root chats were unlistable and unreadable — a keeper (or an external
  `/mcp` client) could not reach a single one.

  A workspace key is a path relative to `projectsRoot`, so the root's key is the
  empty string, and every workspace key on this surface was tested for
  _truthiness_. Two of the three failures were silent:

  - `list_chats {"project": ""}` named an explicit target and got a **different**
    target's answer — the empty key collapsed into "no filter", so it listed every
    _project's_ chats (and then reported zero, since no project owns a root chat).
  - `read_chat {"project": "", …}` answered `` `project` … is required `` for an
    argument that **was** supplied.
  - `list_projects` gave a caller no way to learn the root existed at all.

  Fixed the way REST already solves it — reach the root by key, never by widening
  enumeration. `ProjectStore.list()` is unchanged: it still walks children only.

  Three behaviour changes to the tools:

  - **`list_chats` with no `project` now covers the root as well as every
    project.** It is the only source of session ids, so omitting the root made
    root chats undiscoverable. Root chats report `project: ""` — pass that value
    back to `read_chat` verbatim.
  - **`list_chats {"project": ""}` and `read_chat {"project": ""}` now address the
    root workspace** instead of misfiring. An _absent_ `project` still means "all
    workspaces" for `list_chats` and is still a hard error for `read_chat`.
  - **`list_projects` gained a `root` field** — the root workspace, mirroring the
    `{ projects, root }` shape `GET /api/projects` settled on. It is deliberately
    **not** in `projects` or `count`: the root is not a project. `root` is `null`
    for a client whose scope doesn't reach it.

  The `project` descriptions/schemas on `list_chats`/`read_chat` now name the
  empty key, replacing text ("Omit to list chats across all projects") that was
  itself part of the confusion. Scoping is unaffected: a client's `projects`
  patterns are matched against `""` like any other key, so a narrowly-scoped
  client still sees no root chats.

## 0.54.2

## 0.54.1

### Patch Changes

- [#600](https://github.com/edspencer/paddock/pull/600) [`b047b9c`](https://github.com/edspencer/paddock/commit/b047b9c0bbe409fce8c64935db61e03fba54f182) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to **5.27.1**, which carries two data-integrity fixes to the
  session layer Paddock reads on every listing.

  **herdctl#419 — a failed metadata _read_ no longer destroys the file.**
  `SessionMetadataStore.loadMetadata()` collapsed three outcomes into one `null`:
  the file was absent (legitimate — storage is sparse), it could not be read
  (EACCES/EIO/truncated), or it failed schema validation. All seven setters then
  treated `null` as "start fresh" and `atomicWriteJson`'d an empty file over the
  top, silently wiping every `customName`, `preview`, `autoName`, `isSidechain`
  and `usage` entry for that agent. Nothing surfaced an error — the write
  succeeded, so it looked clean.

  This was reachable in normal operation, not just under exotic disk faults: a
  routine listing warms the enrichment cache, which is exactly the read-then-write
  that triggers it. On this instance the blast radius was ~1,500 sessions of
  user-authored chat names per agent file. 5.27.1 distinguishes _absent_ from
  _unreadable_ — absent still creates an empty file, unreadable now throws
  `SessionMetadataUnreadableError` **without writing**, leaving the bytes on disk
  and recoverable.

  **herdctl#424 — one unreadable transcript entry no longer blanks a listing.**
  An entry that `stat()`s as a valid `.jsonl` but is actually a directory (Linux
  `open(2)` succeeds, `read(2)` throws `EISDIR`) threw out of per-session
  enrichment and took down the whole result: `getAgentSessions` lost the agent's
  entire list and `getAllSessions` lost _every_ agent's. Enrichment is now
  isolated per entry — the bad one is skipped and warned, the rest still list.

  The two fixes were verified to **compose**, not merely to co-exist: an
  integration test upstream drives both failure modes simultaneously (a real
  poison directory _and_ a real corrupt metadata file) and asserts the good
  sessions still list, `sessionCount` stays in sync, and the corrupt file survives
  byte-for-byte. Each fix was also shown to be load-bearing by reverting it and
  confirming the _right_ assertion fails.

  No Paddock code changes — `^5.27.0` already admitted this range; this pins the
  floor so the lockfile resolves to a build containing the fixes.

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

- [#598](https://github.com/edspencer/paddock/pull/598) [`8b2fd83`](https://github.com/edspencer/paddock/commit/8b2fd838ee2c9d546bd841b3d96d364e372d218f) Thanks [@edspencer](https://github.com/edspencer)! - Retire "keeper" from the OpenAPI surface (#585) — the last gap left by the
  config/env (#592), docs (#593) and UI (#594) passes.

  The published spec (`openapi-site/open-api.json`) is **generated** from the
  route schemas via `app.swagger()`, so the wording was fixed at source in
  `packages/server/src` and the spec regenerated with
  `npm run build:server && node scripts/dump-openapi.mjs`:

  - The API `info.description` no longer calls Paddock "the keeper-agent
    platform" — it is the Claude Code workspace platform (`openapi.ts`).
  - `POST /api/projects`, `PATCH`, `DELETE` and `POST .../promote-to-repo`
    describe registering/re-registering **the project's agent and its sweeper**
    rather than "the keeper"; the `model` / `permissionMode` / `maxTurns` /
    `docker` / `driveMode` / `recovery` body-field descriptions follow.
  - `GET .../commands` is now "List a project's slash commands".
  - `POST .../chats/:sessionId/promote` creates "the project + its agent".

  Also `openapi-site/index.html`'s meta description (hand-maintained, not
  generated), and the `/api/models` row in `docs/API.md`, which still named the
  pre-#592 `keeperDriveModeDefault` response field.

  Descriptions only — no route, parameter, schema or status code changed. The
  `keeper-<slug>` agent-name prefix is untouched, as in #592.

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

- [#581](https://github.com/edspencer/paddock/pull/581) [`3c439f1`](https://github.com/edspencer/paddock/commit/3c439f15b2bac7e79a96d7baf813561959589b5f) Thanks [@edspencer](https://github.com/edspencer)! - Give the sweeper its own working directory, so a chat can no longer be bound to
  the curator's transcript (#548).

  A CLI agent's `working_directory` is what Claude Code encodes into its transcript
  path, so two agents sharing a cwd share one session directory. The keeper's cwd
  is `project.workingDir` and the sweeper's was `project.dir` — **identical for a
  notebook project**, so both wrote their transcripts into the same `.chats/`.

  herdctl identifies a freshly-spawned session by set-difference against a
  pre-spawn snapshot of that directory. That is immune to a co-located agent
  _appending_ to its own session, but not to one _creating_ a new file: whichever
  brand-new `*.jsonl` appears first is claimed as "ours". Since a sweep is
  scheduled after every keeper turn — with **zero delay** after a project's first
  turn, because the interval watermark is still unset — the sweeper's spawn raced
  the following keeper turn. When the sweeper's file landed first, the user's turn
  was handed the sweeper's session id, and the consequences all followed from that
  one substitution: the curation text streamed back as the reply, resuming the chat
  resumed the curation transcript (so the keeper had no memory of the conversation),
  and the chat could vanish from the project's list entirely — the sweeper is the
  one deliberately hidden agent, so a session attributed to it is filtered out.

  The sweeper is tool-less: it reads nothing and writes nothing, because
  `SweepService` gathers the project's files itself, inlines them in the prompt, and
  writes the curated results itself. Its cwd was therefore inert, and moving it to a
  dedicated per-project directory under the data root removes the shared directory —
  and with it the whole collision class — structurally rather than by timing. The
  directory is kept outside `projectsRoot` on purpose: core's discovery unions every
  transcript bucket whose decoded path is a strict descendant of an agent's cwd, and
  the root workspace's cwd _is_ `projectsRoot`.

  Existing sweeper transcripts stay where they are and are simply no longer read;
  they were never surfaced in the UI (the sweeper is hidden), and curation does not
  consult its own history.

  This was the whole of paddock#548, the intermittent `packages/server` integration
  failure that made a red CI indistinguishable from a real regression. It presented
  as three unrelated-looking assertions — a renamed chat missing from the list, a
  resumed chat that had forgotten its codeword, and a transcript read that came back
  empty — and it explains the otherwise-odd invariant that a failing run always
  failed _exactly one_ test: there is only one prompt sweeper spawn per project, so
  at most one turn could be hijacked.

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

### Patch Changes

- [#532](https://github.com/edspencer/paddock/pull/532) [`87e3118`](https://github.com/edspencer/paddock/commit/87e3118b9a3db0665abf8c339a39ffd86e7555a4) Thanks [@edspencer](https://github.com/edspencer)! - devbox image: add `kubectl`. A keeper asked "is the deploy healthy?" needs one
  binary to make a cluster legible — describe a pod, tail logs, check a rollout —
  and no amount of credentials substitutes for the client being absent. Same shape
  as the Docker CLI already in the image: the **client only**, with **no kubeconfig
  and no cluster credentials** baked in; those are per-deployment and belong to the
  operator. It also can't be added downstream, because `kubectl` is in none of the
  apt sources the image carries, so a derived `apt-get install kubectl` fails
  outright. Shipped as a pinned static binary (`KUBECTL_VERSION`, currently
  `1.36.3`) with the per-arch SHA-256 pinned in the Dockerfile and verified at
  build time, selected by `TARGETARCH` so the arm64 image gets an arm64 binary. No
  new apt repository or trust root. Base is untouched; devbox grows ~60 MB on
  ~4.9 GB.

- [#526](https://github.com/edspencer/paddock/pull/526) [`cc0702c`](https://github.com/edspencer/paddock/commit/cc0702cda0ee09a34fd75160c72869f59bb19356) Thanks [@edspencer](https://github.com/edspencer)! - devbox image: add `python3`, `python3-pip`, `python3-venv`, `uv`, `jq` and
  `rsync`. Python is the default reach for a ten-line data transform whatever the
  surrounding project is written in, and `python3: not found` turned that into
  "rewrite it in Node" every time; `jq` and `rsync` were the same gap from the
  other end. The rule this follows is **interpreters and small CLI utilities in
  the image, libraries in the project** — so no AI/data libraries are baked in;
  `uv` is there to make a per-project venv cheap enough that they don't need to
  be. `python3-venv` comes along because Debian marks the interpreter
  `EXTERNALLY-MANAGED` (PEP 668), so a global `pip install` refuses and a venv is
  the supported path. Base is untouched; devbox grows ~124 MB on ~4.9 GB.

- [#530](https://github.com/edspencer/paddock/pull/530) [`c7c5155`](https://github.com/edspencer/paddock/commit/c7c51557f8fcffe11c6472db4a220344995eea17) Thanks [@edspencer](https://github.com/edspencer)! - Require `@herdctl/core` >= 5.27.0, whose `listJobs` is index-backed
  (herdctl#415/#416). Core previously read and Zod-validated every `job-*.yaml`
  sequentially and applied `filter.agent` only afterwards; it now filters, sorts
  and pages against an incremental mtime-keyed index and fully parses only the
  records it returns.

  Measured on this instance's 1,996-record jobs directory, warm:
  `GET /api/projects/:slug/runs` **1.47 s -> 0.15 s** (10x).

  Note `GET /api/projects/:slug/triggers/runtime` is NOT improved by this bump
  (1.28 s -> 1.12 s): `listRunsForAgents` calls `listJobs` with no filter and no
  limit, so nothing is pushed down for the index to exploit. Core exposes only a
  single-`agent` filter, so that path needs a separate Paddock-side change.

- [#530](https://github.com/edspencer/paddock/pull/530) [`c7c5155`](https://github.com/edspencer/paddock/commit/c7c51557f8fcffe11c6472db4a220344995eea17) Thanks [@edspencer](https://github.com/edspencer)! - Cache the jobs-dir scan behind the unread badge (#529). `lastTurnCompletedAt` /
  `lastTurnCompletedAtByProject` used to `readdir` + `YAML.parse` **every**
  `job-*.yaml` on every `/api/projects`, `/api/projects/:slug` and `/chats`
  request. On a real instance (1,996 records, 46.6 MB) a CPU profile put **61% of
  all busy server CPU** in that one parse; because it is synchronous work on the
  single event loop it pinned throughput at ~1.1 req/s and made an unrelated 2 ms
  endpoint take ~0.9 s while a scan was in flight.

  Both now read through a new `JobsDirIndex`, which keeps one entry per record
  keyed on `mtimeMs` + `size`, so a warm scan only parses files it has never seen —
  and is warmed at boot so the first page load doesn't pay for the cold pass. A
  record is only cached once it has a `finished_at`: that is the point at which it
  becomes immutable, so a still-running turn can never be memoized as final.
  Behaviour is unchanged — same `session_id → max(finished_at)` mapping, same
  per-project grouping, same skip-never-throw on a corrupt record; verified by
  diffing every one of 281 `chatTurns` rows and 284 per-chat timestamps against
  the old build on the same corpus.

  Measured on that corpus: `GET /api/projects` 0.86 s → **0.036 s**,
  `/api/projects/:slug/chats` 0.92 s → **0.086 s**, the projects grid's seven
  parallel `/chats` calls 6.19 s → **0.13 s**, throughput at 8 concurrent
  1.06 → **18.5 req/s**, head-of-line blocking of `/overview` 0.89 s → **0.04 s**,
  and in-browser LCP on a project page 2.31 s → **0.33 s**.

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

### Patch Changes

- [#510](https://github.com/edspencer/paddock/pull/510) [`11ce96b`](https://github.com/edspencer/paddock/commit/11ce96b637da6899ba15fde5cd3486a4db2fc05a) Thanks [@edspencer](https://github.com/edspencer)! - fix(chats): record the creating chat on `create_chat`, so the chat tree stops relying on inference (#509).

  The nested chat list resolves a parent edge from `RunProvenance.parentSessionId`
  first, falling back to inferring one from the kickoff message's sender. But
  `startAgentTurn` rebuilt the provenance marker from loose `origin`/`depth`
  scalars, dropping the parent on the `create_chat` path — the dominant way
  children are made. Result: **not one** of the 169 provenance records on the
  dogfood instance carried the field, and every edge in the live tree came from
  inference, which had already needed narrowing once (#491/#504) after it
  re-parented human chats that a child reported back to.

  `StartAgentTurnOpts` now carries an optional `parent`, `create_chat` supplies the
  calling chat, and the stamp persists it. Absent where there is no calling chat
  (schedule/hook fires, and the external `/mcp` transport, which binds
  `currentSessionId` to `null`). Inference is unchanged and still backfills
  historical chats — this only stops manufacturing new ones that need it.

- [#518](https://github.com/edspencer/paddock/pull/518) [`1983929`](https://github.com/edspencer/paddock/commit/1983929250c678452b7a49de476fedec60ef60e1) Thanks [@edspencer](https://github.com/edspencer)! - fix(projects): refuse hidden (dot-prefixed) paths on the file surface, don't just omit them from listings.

  `listFiles` has always dropped dot entries from what it _returns_ — but that is
  presentation, not access control. Naming the path explicitly still resolved it,
  and the read route's `:name` param decodes `%2F`, so a nominally single-segment
  route accepts a whole nested path. Together those made
  `GET /api/projects/:slug/files/.chats%2F<id>.jsonl` return a full chat
  transcript, and `…/files/.git%2Fconfig` return a git config — which carries
  credentials when a remote embeds a token. `?path=.chats` likewise enumerated
  every transcript filename.

  The root project (#516) widened the blast radius from one project's subtree to
  the instance's own backing repo and every project at once, which is what
  prompted the audit.

  `resolveInProject` now rejects any dot-prefixed segment, checked against the
  RESOLVED path relative to the project dir — so `a/../.git` and `./.git` are
  caught alongside a literal `.git`, while a project dir that legitimately sits
  under a dot-prefixed ancestor (e.g. `/srv/.paddock/projects`) still works.

  **Honest severity: defense-in-depth, not a privilege boundary.** Paddock has no
  per-user role model, and any caller who can reach these routes can already start
  a keeper chat and run Bash — strictly more capability than reading a file. The
  `/mcp` read-only token surface exposes no file verb, so it was never reachable
  there. Worth closing because "hidden in the listing" should not be the only
  thing between an API and a transcript. Nothing in the UI regresses: the Files
  browser never listed dot entries, so it never had a link to one.

  The leaf may still be a dotfile. Refusing _every_ dot segment was the first cut
  and it broke the Changes pane: an untracked file has no diff, so the pane renders
  its content through this same surface — and `.gitignore` is untracked in a fresh
  repo-backed project, because `ensureSidecarGitignore` writes it. The harm is
  descending _into_ `.git/` and `.chats/`, not reading a dotfile git is already
  showing you. `listFiles` additionally refuses a hidden leaf, since listing one is
  how `?path=.chats` enumerated every transcript.

## 0.48.1

### Patch Changes

- [#505](https://github.com/edspencer/paddock/pull/505) [`770439e`](https://github.com/edspencer/paddock/commit/770439e5637e3e1242df89129e322a6927d91e9f) Thanks [@edspencer](https://github.com/edspencer)! - Management API: only believe `X-Forwarded-Proto` from a trusted proxy (#474)

  The `/mcp` plaintext guard refuses a bearer token over a plaintext non-loopback
  connection. It honoured `X-Forwarded-Proto: https` from **any** peer, so the
  guard could be switched off by the caller — including by the operator it exists
  to protect, copy-pasting a header out of a smoke-test recipe onto a real network.

  The forwarded scheme is now believed only when the immediate peer (the socket
  address, which no client can set) is a trusted proxy. New
  `managementApi.trustedProxies` / `PADDOCK_MANAGEMENT_TRUSTED_PROXIES`: IPs,
  CIDRs, the presets `loopback` / `linklocal` / `uniquelocal`, or `none` / `all`.

  The default — loopback plus the private address space — keeps every sidecar
  deployment working, while a **public** peer can no longer switch the guard off.
  Name your TLS terminator explicitly to turn the guard into a real control; the
  server logs a one-per-peer warning while it is leaning on the default.

  Not an authentication change: `/mcp` still requires a valid bearer token, and
  spoofing the header never granted access.

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

- [#503](https://github.com/edspencer/paddock/pull/503) [`98321e9`](https://github.com/edspencer/paddock/commit/98321e945ffbe394e6ab64f92de09925827dbd3e) Thanks [@edspencer](https://github.com/edspencer)! - Sweeper: bring the registered `system_prompt` in line with the whole-file
  replace contract the curator has actually implemented since #379. It still told
  the model to emit "exactly ONE changelog bullet line … just the bare sentence"
  and described `CLAUDE.md` as "amend-only … never rewrite existing content",
  while `sweep.ts` and the per-sweep user prompt both ask for the full file and
  `writeChangelog`/`writeClaudeMd` replace wholesale. A model that weighted the
  system prompt over the user prompt replaced the entire `CHANGELOG.md` with one
  sentence — observed in the wild on this repo's own changelog. The prompt now
  asks for the full `CHANGELOG.md` with existing dated entries preserved,
  describes the `CLAUDE.md` curated-notes body as a section replace with dedup,
  and says "three sections" instead of "two". Adds a unit test pinning the
  contract so it cannot silently drift back.

## 0.48.0

### Minor Changes

- [#500](https://github.com/edspencer/paddock/pull/500) [`55c2d2e`](https://github.com/edspencer/paddock/commit/55c2d2e0d98bf753edd235cf14bc024c6f9918f7) Thanks [@edspencer](https://github.com/edspencer)! - `list_chats` (self-management + Management API MCP) now hides archived chats by
  default, matching the web UI, and reports each chat's `archived` flag. Pass
  `include_archived: true` to get them back; the result's `omittedArchived` count
  always says how many were withheld, so an archived chat's `session_id` is never
  silently unreachable.

### Patch Changes

- [#502](https://github.com/edspencer/paddock/pull/502) [`9d98d08`](https://github.com/edspencer/paddock/commit/9d98d08575d5d9ec61c9e0b5304628b803838ccb) Thanks [@edspencer](https://github.com/edspencer)! - Docker images: install `openssh-client` in the base image and the `docker
buildx` / `docker compose` CLI plugins in devbox. The base image shipped `git`
  with no ssh transport, so every `git@` remote failed mid-turn with `error:
cannot run ssh: No such file or directory`; devbox shipped `docker-ce-cli` with
  an empty plugin path, so `docker compose` and `docker buildx` were both
  `unknown command`. Both were missing runtime dependencies of tooling the images
  already deliberately include.

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

- [#466](https://github.com/edspencer/paddock/pull/466) [`927504d`](https://github.com/edspencer/paddock/commit/927504d8730e12640ffe5d281902f95942593c40) Thanks [@edspencer](https://github.com/edspencer)! - Add an opt-in OpenAPI / Swagger reference, generated from the server's route schemas.

  - Every REST route now carries a Fastify JSON schema (tags / summary / params / querystring / body / response); `@fastify/swagger` collects them into a live OpenAPI 3 document. Schemas are permissive on input and non-stripping on output, so runtime behaviour is unchanged.
  - Swagger UI mounts at `/open-api` (raw spec alias at `/open-api.json`), Paddock-branded, with **mode-aware security schemes** (bearer for `jwt`, apiKey for `trusted-header`) so the Authorize button reflects the instance's auth. Same-origin requests behind a proxy inherit the SSO session automatically.
  - New instance config `PADDOCK_OPENAPI_ENABLED` (**default off — opt-in**) and `PADDOCK_OPENAPI_PATH`. When enabled, a **Swagger API** link appears in the sidebar.
  - Renamed the sidebar/page label **"Instance settings" → "Settings"**.
  - Added `scripts/dump-openapi.mjs` and a self-contained `openapi-site/` (branded Swagger UI + generated spec) for hosting a static API reference (e.g. Cloudflare Pages).

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

- [#461](https://github.com/edspencer/paddock/pull/461) [`d5b265c`](https://github.com/edspencer/paddock/commit/d5b265cec2bd721ed38894858fc978f5e5f081a4) Thanks [@edspencer](https://github.com/edspencer)! - fix(chat): flush a queued follow-up after a session-mode turn that ended
  `success:false` (#404).

  A message queued while the keeper was still replying was silently dropped in
  session drive-mode. The queue drain (and the after-turn curation sweep and the
  recovery-watch arm) were gated on herdctl's raw `result.success`, which in
  session mode routinely reports `false` on a turn that produced a complete reply
  but ended with a trailing `error_*` / `success:false` result frame — the same
  signal the #380/#394 false-"turn failed" banner fix already learned to distrust.

  The live banner path suppressed the benign failure via `producedReply`, but the
  post-turn side effects never got the same treatment, so the queued message
  stranded. This extracts a single `turnEffectivelySucceeded(rawSuccess,
producedReply)` predicate — the side-effect twin of `suppressNoticeAfterReply` —
  and routes the drain, sweep, and recovery gates through it on both the
  human-chat path and the shared trigger/spawn/wake turn engine, so a real reply
  supersedes a benign trailing failure and the four gates stay consistent. A
  genuinely dead turn (no reply) still holds its queue and keeps its error banner.

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

- [#438](https://github.com/edspencer/paddock/pull/438) [`011bb9d`](https://github.com/edspencer/paddock/commit/011bb9dabf23d2d0674680535a115819d25d1ef6) Thanks [@edspencer](https://github.com/edspencer)! - Safe-by-default binding (#435): the bind host now defaults to `127.0.0.1`
  (loopback only) instead of `0.0.0.0`, so a fresh source/tarball run is
  network-closed. A new bind-safety guard couples exposure to authentication —
  binding a non-loopback host while `PADDOCK_AUTH_MODE=none` **refuses to start**
  (mirroring the jwt-without-JWKS fail-closed check) unless
  `PADDOCK_DANGEROUSLY_ALLOW_OPEN` is set, in which case it boots with a loud
  warning. Binding non-loopback with a real auth mode (`trusted-header`/`jwt`)
  needs no flag, and deployments that set `HOST`/`PADDOCK_HOST` explicitly are
  unaffected — only the default changed. The container image keeps binding
  `0.0.0.0` (the network namespace is its boundary); recipes carry the host-side
  publish posture.

### Patch Changes

- [#448](https://github.com/edspencer/paddock/pull/448) [`c8ab500`](https://github.com/edspencer/paddock/commit/c8ab500e2dab34f06b1fcbdf597fab2a5e06cd6a) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to 5.26.1. Picks up two herdctl fixes: durable session wakes are now retired when the agent runs `CronDelete` (recurring `CronCreate`/`/loop` wakes are cancellable again instead of firing until the 7-day prune), and `tool_reference`-content tool results are preserved so ToolSearch cards no longer stick in a RUNNING state.

- [#439](https://github.com/edspencer/paddock/pull/439) [`83ab73a`](https://github.com/edspencer/paddock/commit/83ab73a33f3b6ece6f6d4c1b7daa99d870bc1781) Thanks [@edspencer](https://github.com/edspencer)! - Remove the dead `devServers` / `PADDOCK_DEV_SERVERS_ENABLED` config. It was loaded and unit-tested but nothing consumed it — it used to gate the system-prompt style before #176 decoupled that into `PADDOCK_KEEPER_NATIVE_PROMPT`. The `PADDOCK_DEV_SERVERS_ENABLED` / `PADDOCK_DEV_SERVERS_DOMAIN` env vars, the `devServers` config block, and the associated instance-config field are gone. The preview-server (`pm`) capability is provided by the devbox image and advertised via an instance-wide `CLAUDE.md`, not a Paddock flag.

- [#444](https://github.com/edspencer/paddock/pull/444) [`8f5f4cd`](https://github.com/edspencer/paddock/commit/8f5f4cdf6f4cc0721a5a4296e552ae918996baf1) Thanks [@edspencer](https://github.com/edspencer)! - Docs: add a **Running Paddock on Kubernetes** guide (#415). Covers when a cluster makes sense, the Kustomize manifest layout, the `/data` PVC and single-writer statefulness (`replicas: 1` + `Recreate` + `ReadWriteOnce`, on which resume depends), the Claude/GitHub token Secret, base vs. `:devbox` image, and ingress with auth at the edge. Links the `kubernetes/` recipe in `paddock-deploy` and the Securing Paddock guide.

- [#446](https://github.com/edspencer/paddock/pull/446) [`e4d6eb3`](https://github.com/edspencer/paddock/commit/e4d6eb3f3ee323b529c6db37ab0a2d0a341fb8fc) Thanks [@edspencer](https://github.com/edspencer)! - Docs: add a **Running Paddock on Proxmox (LXC)** guide — a bridge between the generic Deploying guide and the home-lab narrative. Covers creating an unprivileged Debian LXC (UI / `pct` / the `proxmox-iac/` Tofu module, incl. `nesting=1,keyctl=1` for Docker/devbox), then both deploy paths: **Path A** — `docker run` inside the LXC (`paddock-deploy/docker/`), and **Path B** — tarball + systemd via OpenTofu + Ansible (`paddock-deploy/proxmox-iac/`). Links the Securing guide and the `auth-basic/` Tier-1 sidecar, and explains the safe-by-default loopback bind + `PADDOCK_DANGEROUSLY_ALLOW_OPEN` for the container case.

- [#443](https://github.com/edspencer/paddock/pull/443) [`4509b1e`](https://github.com/edspencer/paddock/commit/4509b1e376b5ac10bf1f27138bd60e1bb01a6f88) Thanks [@edspencer](https://github.com/edspencer)! - Docs: refresh the **Securing Paddock** guide into a four-tier ladder — Tier 0 network isolation (`none` + VPN), Tier 1 sidecar Basic Auth (`trusted-header`, recipe in `paddock-deploy/auth-basic/`), Tier 2 Cloudflare Access (`jwt`), Tier 3 Authentik/Authelia forward-auth (`jwt`) — all edge-based, no built-in password. Adds the Cloudflare Access `jwt` config and links the new Basic Auth sidecar recipe.

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

## 0.43.0

### Minor Changes

- [#430](https://github.com/edspencer/paddock/pull/430) [`a8ef992`](https://github.com/edspencer/paddock/commit/a8ef992edbedb4ee22c3ef05f736c2355906d366) Thanks [@edspencer](https://github.com/edspencer)! - Session-mode background work now survives an opening turn and streams its results live.

  - **Survival on the first/opening turn.** A background task (`run_in_background` Bash, or a background `Task` sub-agent) launched on a fresh chat's first turn is no longer killed at the turn boundary. The fresh consume path used to end the turn with a `break` that tore down the underlying `claude` process; it now stops without closing and hands teardown to the reaper, which keeps a session alive while it holds live background work — matching the resume path.
  - **Live delivery of autonomous re-invocations.** When a background task completes, the keeper's follow-up ("background command completed") turn now streams to the open chat with no refresh. Paddock keeps consuming the same session stream after the primary turn, which also keeps the runtime's background-lifecycle signals flowing.
  - **Coherent background sub-agent rendering.** A background sub-agent's nested steps no longer spill into the transcript as top-level rows; the sub-agent renders as one card (its nested steps remain available on expand), consistent with the foreground and on-reload views.

  Known limitation (tracked as a follow-up): while a background sub-agent is still running, its card shows a generic launch acknowledgement and only enriches to its real type, title, duration, cost, and expandable nested steps after a refresh.

## 0.42.5

### Patch Changes

- [#428](https://github.com/edspencer/paddock/pull/428) [`5fabf73`](https://github.com/edspencer/paddock/commit/5fabf73a5dbbdb0414f9f11d7e58d42af6e6bd51) Thanks [@edspencer](https://github.com/edspencer)! - Fix the resume self-interrupt that lost the human turn (#427). A resume consumer broke its message loop on the FIRST `result`; when a resumed session had a pending async-input backlog (e.g. leftover killed-task notifications), the CLI replayed that backlog as its own turn whose `result` closed the CLI (~2s grace) and killed a slow human turn. All resume consumers now drain the backlog before breaking (residue-gated drain-then-prompt via `consumeResumedTurn`), so the human turn is the last one and survives.

- [#421](https://github.com/edspencer/paddock/pull/421) [`219e0f7`](https://github.com/edspencer/paddock/commit/219e0f77f3836731f2061d7f3dc93442c4678ffb) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `projects.ts` (~1380 lines) into focused sibling modules, leaving `ProjectStore`'s metadata/yaml-serialization core cohesive. Extracts the MIME maps + `fileKind`/`contentTypeFor` into `project-mime.ts`, the `project.yaml` schema + `Project` DTO + create/update inputs + `normalizeLinks` into `project-types.ts`, the pure slug/repo-URL/path helpers + `ProjectError` into `project-paths.ts`, and the read-only freeform-file surface (`listFiles`/`readFile`/`readFileBytes`/`readFileWithKind`) into `project-files.ts` (pure `(root, slug, …)` functions the store delegates to). `projects.ts` drops to ~860 lines; the public import surface is unchanged (all moved names are re-exported from `./projects.js`) and behavior is identical. Part of #403.

- [#423](https://github.com/edspencer/paddock/pull/423) [`f93b32d`](https://github.com/edspencer/paddock/commit/f93b32dd13346975513aaa1b0f1fcdc45a399383) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `routes.ts` (~1940 lines) Fastify REST surface into focused per-group modules, leaving `routes.ts` a ~40-line composition root. Behavior is identical — same routes, same responses, same direct `app.<verb>()` wiring (no Fastify plugins). Extracts the pure helpers into `http-bytes.ts` (`parseRangeHeader`/`cspFor`), `route-errors.ts` (`sendProjectError`), and `chat-dto.ts` (`ChatUsage`/`toChatUsage`/`toChatDto`/`buildProjectChats`/`makeTriggerResolver` + runs-limit consts); lifts the shared `RouteDeps` bag + helper closures into a `RouteCtx` built once by `buildRouteContext(deps)` in `route-context.ts`; and delegates the ~50 handlers to per-group `registerXRoutes(app, ctx)` functions in `routes/{meta,git,projects,triggers,chats}.ts`. `registerRoutes`/`RouteDeps`/`parseRangeHeader` remain exported from `./routes.js`. Part of #403.

- [#424](https://github.com/edspencer/paddock/pull/424) [`6a35367`](https://github.com/edspencer/paddock/commit/6a353671ce6372c2e382b9289a2b8b659c3a2713) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `ws.ts` (~2880 lines — the WebSocket chat transport, the flagship of #403) into focused sibling modules, leaving `ws.ts` as the thin socket layer (the `makeChatHandler` shell, `onSessionWake` streaming, and the `handle` dispatch + `onChatSend`/`onChatCommand`/`onSubscribe`/`onSetQueue`/`onChatContinue` handlers). Extracts: the wire protocol (all `ClientMessage`/`ServerMessage` interfaces + unions + `isClientMessage`) and per-turn token/usage helpers into `ws-protocol.ts`; the named `ChatHandlerDeps`/`StartAgentTurn` context types into `ws-context.ts` (the enabling move); the `paddock_manage` MCP builder (`buildSelfMcpServerDef`) + `forkKickoffPrompt` into `ws-self-mcp.ts`; the trigger/schedule/event firing cluster into `ws-triggers.ts` (a `makeTriggerCluster` factory); and the mutually-recursive turn-execution engine — `startAgentTurn`, the injected-MCP builders + wake cache, and Layer-2/3 recovery — into `ws-turn.ts` (a `makeTurnEngine` factory). `ws.ts` drops from ~2880 to ~1040 lines; the public import surface is unchanged (all moved names are re-exported from `./ws.js`) and behavior is identical. Part of #403.

## 0.42.4

### Patch Changes

- [#420](https://github.com/edspencer/paddock/pull/420) [`7d62c81`](https://github.com/edspencer/paddock/commit/7d62c8132d52275f1faece87ee54cc4a21eb4095) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to 5.26.0, picking up herdctl #406/#407: the SessionReaper now defers its turn-end reap when a session is resumed with a prompt, so a replayed backlog turn on resume can no longer reap the resumed human turn out from under it (the `[Request interrupted by user]` self-interrupt).

- [#419](https://github.com/edspencer/paddock/pull/419) [`1b9802d`](https://github.com/edspencer/paddock/commit/1b9802d8200d1130e372787749f11d753e916a91) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `herdctl.ts` (~1660 lines) into focused sibling modules, leaving `HerdctlService` as the cohesive stateful seam. Extracts the pure name/visibility helpers + constants into `herdctl-agent-names.ts`, the four agent-config builders + `ensureConfigFile` into `herdctl-agent-config.ts` (pure functions taking `cfg`), and the on-disk `job-*.yaml` reads + adoption/attribution writes into `herdctl-jobs.ts`. `herdctl.ts` drops to ~975 lines; the public import surface is unchanged (all moved names are re-exported from `./herdctl.js`) and behavior is identical. Part of #403.

- [#417](https://github.com/edspencer/paddock/pull/417) [`369d1da`](https://github.com/edspencer/paddock/commit/369d1da8e8e890d52b45c9046c68a643c5f65a1c) Thanks [@edspencer](https://github.com/edspencer)! - Refactor: split the oversized `self-mcp.ts` (~1160 lines) into focused per-tier modules (`self-mcp-{types,util,descriptions,read,write,triggers}.ts`), leaving `self-mcp.ts` as a thin assembly root that re-exports the public surface. Pure mechanical extraction — no behavior change; the `paddock_manage` MCP tool set and every import path are unchanged. Part of #403.

## 0.42.3

### Patch Changes

- [#401](https://github.com/edspencer/paddock/pull/401) [`1ef134d`](https://github.com/edspencer/paddock/commit/1ef134d5caf44c41ffcfc426c55da9ff05ef933c) Thanks [@edspencer](https://github.com/edspencer)! - Bump `@herdctl/core` to `^5.25.0`, which fixes the double-resume interrupt class at its source (herdctl#403/#404): `openChatSession(resume)` now consults `SessionReaper.isSessionLive` before spawning and defers a real resume until the session is reaped, instead of launching a second `claude` for an already-live session and self-interrupting. This is the fundamental fix that complements Paddock's own RecoveryEngine defer-and-retry guard (#397), and closes the whole class (auto-recovery, manual Continue, queued-drain, wake).

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
