# Design: the `own → host` transcript migration API (#882)

Status: **proposed (2026-08-15)** — the HTTP surface behind the #882 banner and
modal. Endpoint shapes, classification staging, cost budget, and the safety
contract. Implementation is not covered; this is the argument, so it does not
have to be re-run in three months.

Scope: the API only. The banner's placement (`FleetReadout`), the modal's visual
design, and the three-state table are settled in #882 and its comment and are
taken as given here.

---

## 0. What changed after reading the code

Three findings from the code and from measurements on a real 2,599-chat
`transcripts: own` instance change the design rather than decorate it. They are
argued in full below; stated up front because everything else depends on them.

1. **The migration's invariant is "`.chats/` ends up empty", not "move these
   file types."** The spec enumerates `*.jsonl`, `<id>/subagents/` and
   `.reverts/`. That enumeration is already incomplete on a live instance, and
   an enumeration is the wrong shape of rule regardless — see §5.

2. **`.chats/pre-migration/` as specified would ship #708's own symptom.**
   Verified against the real `ensureProjectChats`. The preserved copies have to
   live outside `.chats/`. See §5.1.

3. **The fast-forward test is not a full scan.** The spec frames it as "does the
   shorter transcript's last record `uuid` appear in the longer one", which reads
   as an unbounded grep. Because a transcript is append-only, a genuine ancestor's
   last record *ends at byte offset `shorter.size`* in the longer file, so the
   uuid can be found with a bounded read at a known offset. Measured 298 hits /
   **0 misses** over 300 real transcripts. The full scan is only needed to
   *confirm divergence*, never to confirm a fast-forward. See §3.

---

## 1. The endpoints

Three operations, in a new `packages/server/src/routes/transcripts.ts` exporting
`registerTranscriptsRoutes(app, ctx)`, wired into `routes.ts:45` beside
`registerDiscoverRoutes` and added to the route-map comment at `routes.ts:12-22`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/transcripts/migration` | Banner probe. "Is there anything to migrate?" Cheap. |
| `GET` | `/api/transcripts/migration/chats` | The modal's table. Per-chat rows with classification. |
| `POST` | `/api/transcripts/migration` | Execute: quiesce, move, write config, report. |

Instance-level, so absolute paths registered directly on `app`, matching
`registerDiscoverRoutes` and `registerMetaRoutes` (`routes.ts:42-45`). Not
workspace-scoped: `claude.transcripts` is an instance-global lever, and mounting
this under `/api/projects/:slug` would imply a per-project flip that does not
exist.

`tags: ["System"]` — the existing tag for instance-level routes
(`openapi.ts:27-41`; `/api/discover` and `/api/instance-config` both use it). No
`operationId`: the codebase sets it nowhere.

The path shape mirrors `/api/discover` + `/api/discover/sessions` exactly: a
summary noun, then a sub-resource for the expensive detail.

---

## 2. Design question 1 — one preview endpoint or two?

**Two.** `GET /api/transcripts/migration` and
`GET /api/transcripts/migration/chats`.

The tempting alternative is one endpoint with `?summary=true`. It is rejected for
a reason that is not primarily about performance, and that this repo has already
written down. `routes/discover.ts:9-18`, explaining why *that* feature is also
two paths rather than one:

> Paddock publishes an OpenAPI 3 document GENERATED from these Fastify route
> schemas … and one path cannot describe two different 200 bodies there — **it
> would have to be declared `additionalProperties: true` with no shape at all,
> and the published contract would silently stop describing the endpoint.**

A `?summary=` flag on one path forces exactly the defect #822 was filed about.
Since specifying the schemas properly is the point of this design (§7), a shape
that structurally cannot be specified is disqualified before cost enters the
argument.

Cost then confirms it independently: the summary is **~9 ms** and the full table
is up to **~1.9 s** on a 500-chat instance (§3). Those want different cache
lifetimes and different call sites — the banner is fetched on every page load, the
table only when the modal opens.

### Rejected: fold the banner field into `GET /api/fleet`

Genuinely attractive — `FleetReadout` already renders from the fleet payload
(`meta.ts:328`), so a single extra field would cost zero additional requests and
zero new polling.

Rejected on two grounds:

- **Different invalidation.** `/api/fleet` is a hot path polled continuously
  because it shows running turns and unread counts. Migration state changes only
  when a chat is created or the config flips. Riding the hot poll means paying
  the probe forever, on every instance, including the majority already on `host`
  where the answer is permanently "nothing".
- **It is a posture change, and it should be explicit.**
  `website/src/content/docs/guides/what-paddock-touches.md:34` currently promises
  that under `own`, `~/.claude/projects/` is "not read, not written", and
  `transcripts.ts:180` says the same. The preview **must** read
  `~/.claude/projects/<enc>` to tell `New` from `Fast-forward`. Putting that read
  behind its own endpoint keeps it something the SPA asks for, rather than
  something every fleet poll does silently. (The doc line needs updating either
  way — see §8.)

### Rejected: put the summary on `GET /api/instance-config`

That payload already carries `configPath`, `configVersion` and `restartRequired`,
so it looks like a home. But the banner's whole point is that it does not depend
on the user visiting Config — that is stated in #882's comment as the reason for
the `FleetReadout` placement. Coupling it to the Config screen's payload
reintroduces the dependency the placement decision removed.

---

## 3. Design question 2 — cost

### 3.1 The staged classifier

Four stages, each a strict filter on the next. Prior art: the staging is what
#882 already sketches (`stat` reject → tail read), `dirKey` caching is the idiom
at `adoptable.ts:628-633`, and the tail read is `last-activity.ts`.

| Stage | Work | Rules out |
|---|---|---|
| **0** | `readdir` `<project.dir>/.chats` and `<userHome>/projects/<enc(workingDir)>` | Everything. A chat id present only in `.chats` is **`New`** — classified with no `stat` and no read at all. |
| **1** | `stat` both sides for ids present in both | Equal `size` **and** `mtime` → identical, no row, no read. |
| **2** | Tail-read the *shorter* side's last record `uuid` (32 KB window), then a **bounded probe** of the longer side in a 32 KB window ending at byte `shorter.size` | A hit → **`Fast-forward`**. Confirmed correct on 298/300 real transcripts, 0 misses. |
| **3** | Full scan of the longer side for that uuid | A hit → still `Fast-forward` (a rewritten history). A miss → **`Diverged`**. |

Stage 2 is the load-bearing addition. `#882` assumes the fast-forward test costs a
full scan of the longer file *per conflicted chat*; it does not, because
append-only means the ancestor's last record sits at a *known offset*. Stage 3
survives only as the divergence-confirming fallback, and only for chats that
genuinely diverged.

The classification of `New` — which is the bulk of what the motivating user has,
and the reason the banner exists at all — costs **two `readdir`s per project and
nothing else**.

### 3.2 Measured cost

Constants measured on this box against the real corpus: 2,599 transcripts,
1,459 MB, mean 575 KB, across 16 stores. Warm page cache; full-scan throughput
191 MB/s.

Scaled to the requested scenario — **500 chats across 10 projects**:

| | Cost |
|---|---|
| **Banner** — `readdir` ×2 per project, short-circuit on first `New` | **9 ms** |
| Preview, realistic (all 500 `New`; host store empty) | **24 ms** |
| Preview, all 500 present on both sides, all `Fast-forward` (stages 0–2) | **379 ms** |
| Preview, **worst case**: all 500 present on both sides and all `Diverged` (stage 3 on every row, 281 MB read) | **1,852 ms** |

So: **the worst case for the preview scan on a 500-chat instance is ~1.9 seconds**,
and it requires every single chat to exist on both sides *and* to have diverged —
a state reachable only by adopting everything and then advancing both copies. The
realistic figure for the user in #882's motivating story, who never imported
anything, is **24 ms**.

For calibration at the size this box actually is (2,599 chats), the same worst
case is ~9.6 s and the realistic case ~100 ms.

### 3.3 Bounding

Two bounds, because the worst case is a *product* of chat count and transcript
size and neither is under our control.

- **`DIVERGENCE_SCAN_BUDGET_BYTES = 256 MB` per preview request.** Stage 3 draws
  from a shared budget, largest-file-last. When it is exhausted, remaining
  conflicted rows are classified **`unknown`**, default to unchecked (the
  `Diverged` treatment — the conservative direction), and the response sets
  `scanBudgetExhausted: true` with the count. Nothing is silently truncated;
  "no silent caps" is the rule and the count is the disclosure.
- **No cap on rows.** Capping the table would hide chats from a decision the
  user is being asked to make, which is the failure mode this whole feature
  exists to prevent. `New` rows are free (stage 0), so an unbounded row count is
  not an unbounded cost.

### 3.4 Caching

Per project, cache key is the `dirKey` idiom from `adoptable.ts:354-357`
(`mtimeMs:size` of a directory — "has its file *set* changed"):

```
key = dirKey(<project.dir>/.chats)
    + "|" + dirKey(<userHome>/projects/<enc(workingDir)>)
    + "|" + instanceConfigVersion(configPath)
```

Two `stat`s per project to validate, which is why the banner can afford to be
called on every page load. The config version is in the key so the cache drops
the moment the lever moves.

The banner endpoint additionally **short-circuits**: it stops at the first `New`
id it finds in the first project that has one. It never needs stages 1–3, because
"is there anything to migrate?" is answered `true` by any `New` chat, and #882
explicitly rules that the banner does not vary by *what kind* of pending chats
exist. The banner therefore never reads a transcript.

---

## 4. Design question 3 — idempotency and safety

### 4.1 Ordering, and where the commit point is

```
1. single-flight guard          — reject a concurrent execute
2. expectedVersion check        — reject a stale config baseline
3. quiesceProject(...) × N      — reject if anything is stuck; NOTHING moved yet
4. re-enumerate from disk       — reconcile the plan against reality
5. move files, project by project
6. write claude.transcripts: host    <-- THE COMMIT POINT
7. respond; the client tells the user to restart
```

Quiesce before any mutation is the rule promote already follows, and for the
same stated reason (`chats.ts:1593-1598`): *"Quiesce BEFORE `projects.create` so
a refusal doesn't leave an empty project behind as a side-effect of a failed
promote."* Here the equivalent is: a 409 must not leave half a migration.

**The config write is last, and it is deliberately the commit point.** Until
step 6 lands, nothing has semantically happened: the running server is still
resolving `own`, the on-disk shape is at worst a partially-emptied `.chats/`, and
that is *indistinguishable from the interim blank-list state #882 already
specifies and already tells the user to expect*. Re-running the migration
reconciles it.

The reverse order — config first, files second — was rejected. A crash between
the two would leave a config that says `host` and files that are still in
`.chats/`, and a restart landing on that is a genuine #708 split rather than a
transient blank list.

### 4.2 Called twice

Not an error. A second `POST` re-enumerates from disk, finds the transcripts
already in the host store, moves nothing, finds the config already `host`, and
returns `200` with `alreadyMigrated: true` and empty `migrated`/`failed` arrays.

The move itself is skip-if-present, mirroring `ensureProjectChats:223`'s
`// don't clobber`. A destination that already exists is never overwritten, so
repetition cannot destroy anything.

### 4.3 A concurrent retry (the browser resends)

The client-side `if (adopting) return;` guard (`ProjectView.tsx:592`) is not
enough — it does not survive a reload, and it does not exist in a second tab.

A module-level **single-flight promise** in the route module: a second `POST`
while one is in flight gets `409 { code: "migration_in_progress" }`. In-memory
and restart-forgetting, which is correct here for the same reason the undo map is
(`herdctl.ts:973-987`) — and doubly so, since the flow *ends* in a restart.

### 4.4 A turn starts between preview and execute

This is what step 3 is for. `quiesceProject` (`turn-interlock.ts:142-154`) runs
per affected project, concurrently so the whole call is bounded by one 10 s
timeout rather than N stacked. Any project reporting stuck sessions → `409` with
the shared `turnRunningError(sessionIds)` body (`turn-interlock.ts:156-170`), and
**nothing has been moved**, because step 3 precedes step 5.

Rejected: pushing stuck chats into a `failed` bucket the way
`POST /chats/batch/delete` does (`chats.ts:1483-1490`). That route is
best-effort-per-chat because deleting 40 chats and failing on 1 is a sensible
partial success. A migration that silently leaves one chat behind in `.chats/`
leaves `.chats/` non-empty — which, per §5.1, breaks the flip for the *whole
project*. It is not a per-item failure; it is a whole-project one. So: refuse.

### 4.5 A turn starts *during* execute — an unresolved gap

`quiesceSession` stops what is running; it does not take a lock. Between step 3
and step 5 a fresh turn can start, and `claude` will hold a transcript path in a
directory being emptied. The window is small (the moves are 24 ms same-filesystem
for 500 chats, §6) and the SPA has the modal open with controls disabled, but the
window is real.

Mitigation in v1: re-check `sessionIsBusy` (`turn-interlock.ts:79-82`) for the
project immediately before its own moves, and abort that project if anything woke
up. This narrows the window to microseconds without inventing a lock.

**This is flagged as an open question, not solved.** A proper fix is a fleet-wide
"refuse new turns" flag for the duration, which does not exist today and is a
larger change than this feature should smuggle in.

### 4.6 The plan goes stale between preview and execute

A chat created after the preview is in neither `sessionIds` nor the preview's
row set. Silently leaving it in `.chats/` would break the flip for its project.

Step 4 re-enumerates and applies **the row's own default** to anything unplanned:
an unplanned chat that classifies `New` is migrated (that is its default), an
unplanned chat that classifies `Diverged` is preserved (that is its default).
Every such chat is reported in the response under `unplanned[]` with its
classification, so the completion summary stays honest.

---

## 5. The invariant: `.chats/` must end up empty

`pointChatsDirAt` (`transcripts.ts:132-151`) is what plants
`<project.dir>/.chats → <host store>` on the next boot, and it declines outright
when `.chats` is a real directory with **anything** in it:

```ts
} else if (st?.isDirectory()) {
    if ((await fs.readdir(chatsDir).catch(() => ["?"])).length > 0) return;   // :145
    await fs.rmdir(chatsDir);
}
```

`fs.readdir` lists dotfiles, so `.reverts/` counts. One leftover entry of any
kind and the symlink is never planted — and every by-path reader in the server
(`subagents.ts`, `usage.ts`, `tooldetails.ts`, `localcommand.ts`, `recovery.ts`,
`readFirstUserText`, plus the hard-failing `forkSession` / `revertSession` /
`promoteSession` / `sessionExists`) keeps resolving
`<project.dir>/.chats/<id>.jsonl` against a directory the migration just emptied.
That is #708's "post-flip chats render but are half-blind" state, made permanent.

So the rule is not an enumeration of artifact types to move. It is a
postcondition: **after a project's migration, `<project.dir>/.chats/` contains
nothing.** An enumeration is the wrong shape because it fails open — anything a
future release starts writing into `.chats/` silently breaks the flip. The
postcondition fails closed, and it is checkable in one `readdir`.

That is worth stating because the spec's enumeration is **already incomplete on a
live instance**. Inventory of this box's stores:

| Entry in `.chats/` | Count here | In #882's list? |
|---|---|---|
| `<id>.jsonl` | 2,599 | yes |
| `<id>/subagents/` | 176 | yes |
| `.reverts/` | 1 | yes |
| `<id>/tool-results/` | **102** | **no** |
| `memory/` — the agent memory dir | **132 files** | **no** |
| flat `agent-<hex>.jsonl` sidechain transcripts at the top level | **45** | **no** |

`memory/` is the sharpest of these. `<claudeHome>/projects/<enc>/memory` is where
the agent harness writes memories (`transcripts.ts:80`), and under `own` that
path resolves through the redirect symlink to `<project.dir>/.chats/memory`.
Confirmed by inode on this box — `/data/projects/.chats/memory/MEMORY.md` and
`/data/claude-home/projects/-data-projects/memory/MEMORY.md` are the same file
(inode 3976857). A `*.jsonl`-only migration strands 132 memory files *and* leaves
`.chats/` non-empty, so it breaks the flip and loses agent memory in one move.

**Contract:** the migration moves every entry of `.chats/` except the preserved
set, then asserts the directory is empty. Anything left behind that is not a
preserved chat is a `failed` project, reported, and its config is not committed.

### 5.1 `pre-migration/` cannot live inside `.chats/` — verified

#882 specifies unchecked chats are preserved at `.chats/pre-migration/<id>.jsonl`.
That directory *is* "anything", so it triggers `:145` and declines the symlink.

Verified by running the **real** `ensureProjectChats`, compiled straight from
`packages/server/src/transcripts.ts`, over a sandbox project through both boots:

```
=== SPEC AS WRITTEN — pre-migration INSIDE .chats/ ===
  .chats                       : REAL DIR [pre-migration]
  <claudeHome>/projects/<enc>  : SYMLINK -> …/home/.claude/projects/…
  herdctl discovery (readdir)  : 1 chat(s)
  by-path read of migrated chat: *** ENOENT — half-blind (#708) ***

=== CONTROL — pre-migration OUTSIDE .chats/ ===
  .chats                       : SYMLINK -> …/home/.claude/projects/…
  by-path read of migrated chat: OK
```

Both scenarios keep the preserved copy on disk; only the location differs. The
migration built to fix #708 would ship #708's symptom.

The existing test pins this state precisely, and reads as reassuring until you
notice which link it is checking (`test/unit/transcripts.test.ts:204-215`):

```ts
expect((await fs.lstat(chats)).isSymbolicLink()).toBe(false);
…
// …and the redirect is still planted, so chat itself works.
expect((await fs.lstat(encodedPath())).isSymbolicLink()).toBe(true);
```

"Chat itself works" is true — herdctl lists through the encoded symlink. It is
the dozen by-path readers `pointChatsDirAt` exists to serve
(`transcripts.ts:119-122`) that do not, and the test asserts nothing about them.

**The one-line change: preserve at `<project.dir>/.chats-pre-migration/<id>.jsonl`**
— a sibling of `.chats/`, not a child. Everything else in the spec's constraint
holds unchanged: nothing is deleted, the path is reported in the completion
summary, and it is documented. The response reports the absolute path per chat
rather than a client-side convention, so this location is not baked into the SPA.

Two alternatives rejected:

- **Weaken `pointChatsDirAt`'s guard to ignore a `pre-migration/` child.** The
  guard is deliberate, documented at `transcripts.ts:128-131` and test-pinned at
  `test/unit/transcripts.test.ts:204-215`. #882 itself says this migration is
  "the sanctioned way past it, not a reason to weaken it." Special-casing one
  filename inside a safety check is how the check stops meaning anything.
- **Preserve inside the host store** (`<host>/pre-migration/`). Puts paddock's
  bookkeeping inside the user's real `~/.claude` folder, which is the one place
  the whole `own`/`host` design is careful about writing to.

### 5.2 What moves with a chat

Per migrated `<id>`:

- `<id>.jsonl`
- `<id>/` in full — `subagents/` *and* `tool-results/`, moved as a directory
- `.reverts/<id>-*.jsonl` — prefix-matched, because `.reverts/` is shared across
  sessions (`herdctl.ts:1988-1993`), so a partial migration must split it

Per project, independent of any chat: `memory/`, and any flat top-level
`agent-<hex>.jsonl`, and anything else present — because of the postcondition.

Note that `promoteSession` (`herdctl.ts:1814-1852`) moves only the `.jsonl` and
already orphans `subagents/` and `.reverts/`. That is a pre-existing bug; this
design must not inherit it, and the shared move helper this needs is probably
also promote's fix.

### 5.3 What does *not* move, and why that is fine

Per-chat state is instance-level JSON keyed on `(agent, sessionId)` —
`archive-state.json`, `star-state.json`, `unread-state.json`, `read-state.json`,
`parent-detach.json`, `run-provenance.json`, `queued-message.json` — and
attribution is `<stateDir>/jobs/job-*.yaml` keyed on `agent` + `session_id` with
no path in it (verified: 2,913 of this box's job records carry a `session_id`;
none carry a transcript path).

Because the migration changes neither the session id nor the agent, **every one
of these keys through unchanged**. This is the concrete payoff of #882's "never
rename a session id" constraint, and it is why a same-id move preserves listing,
stars, read-state and attribution for free.

---

## 6. Design question 4 — synchronous, polled, or streamed?

**Synchronous.** One `POST`, one response, no job id.

Measured, for 500 chats at this corpus's mean transcript size:

| | Cost |
|---|---|
| `rename(2)`, same filesystem | **24 ms** |
| `cp` + `rm`, cross-device (324 MB/s, 281 MB) | **1.3 s** |

Plus quiesce, which is bounded by one 10 s timeout and is normally `idle`
(nothing running) and therefore instant.

So the realistic execute is well under a second and the pathological one is a few
seconds — the same order as the preview, and comfortably inside a single request.

The implementation should **`rename` first and fall back to `cp` + `rm` on
`EXDEV`**. `ensureProjectChats:232` unconditionally uses `cp` + `rm` with the
comment *"rename would EXDEV across mounts"*; that is correct for robustness but
leaves the 53× speedup on the table in the common case where `~/.claude` and the
data dir share a filesystem. `preserveTimestamps: true` is required on the copy
path for the reason given at `transcripts.ts:225-231`.

Rejected alternatives:

- **A polled job with a job id.** There is no job infrastructure to reuse for
  non-agent work: `background-live.ts` explicitly refuses to reconstruct state
  across a restart, `runs.ts` is a pure DTO builder over herdctl's own records,
  and the only durable job artifacts are the engine's. Building the first
  resumable job system in the codebase for a one-shot operation that finishes in
  ~1 s is disproportionate.
- **WebSocket progress frames.** `ws-protocol.ts:849-866` is `chat:*` + `pong`
  and nothing else; there is no non-chat frame, no correlation-id scheme, no job
  envelope. Adding the first one for a sub-second operation buys a progress bar
  nobody will see.
- **Client-driven per-project calls**, the `discoverImport.ts` pattern. Genuinely
  tempting, and it is the house answer to "a modal that runs N operations". But
  it cannot work here: the config write is a single instance-global commit point
  that must happen after *all* projects succeed, and a client that dies halfway
  leaves the instance with some projects migrated and no config write. A
  server-side transaction boundary is the whole point.

**On the restart the user is about to perform:** it is not a hazard for a
synchronous call, because the restart happens strictly *after* the response is
read. And a crash mid-execute is safe by §4.1's ordering — the config write has
not landed, so the instance is still `own` and re-running reconciles.

---

## 7. Design question 6 — schemas

#822's complaint is that both Discover routes publish
`{"type":"object","additionalProperties":true}`, so a generated client sees no
fields. That is the house style throughout `packages/server/src/routes/` — every
`response.200` in `chats.ts` is opaque, with the real shape in English prose in
the `description`.

**These routes deliberately do not follow it.** They publish complete JSON Schema:
named fields, types, `required`, closed enums, `additionalProperties: false` on
response objects. #822 states the preference explicitly — hand-writing shapes into
`reference/api.md` "then drifts from source at the next change", or "they go into
the route schemas and the page can point at the generated spec, as it does for
other routes. **The second is clearly better**".

The `description` prose stays — it is genuinely good and carries the *why*. It
stops being the only place the field list exists.

`additionalProperties: false` on responses is chosen over `true` so the schema is
a real contract rather than a lower bound. Note the Fastify consequence and treat
it as a feature: response serialization strips undeclared keys, so a field added
to the DTO and forgotten in the schema disappears at runtime and is caught by the
integration test rather than silently shipping undocumented.

### 7.1 Shared definitions

```jsonc
// MigrationState — the three-state classification, plus the budget escape.
{
  "type": "string",
  "enum": ["new", "fast-forward", "diverged", "unknown"],
  "description":
    "new = no counterpart in the host store (default checked). fast-forward = a counterpart exists and one side is strictly ahead; lossless (default checked). diverged = both sides advanced independently (default UNCHECKED, requires an explicit choice). unknown = the divergence scan budget was exhausted before this row could be settled; treated as diverged (default unchecked)."
}
```

```jsonc
// MigrationSide — one copy of a chat, for the diverged row's comparison columns.
{
  "type": "object",
  "additionalProperties": false,
  "required": ["path", "sizeBytes", "messageCount"],
  "properties": {
    "path":         { "type": "string",  "description": "Absolute path of this copy." },
    "sizeBytes":    { "type": "integer", "description": "Transcript size in bytes." },
    "messageCount": { "type": "integer", "description": "Conversation records in this copy — `user`/`assistant`, excluding meta and task-notification records, the same rule as last-activity.ts:74-89." },
    "lastMessageAt":{ "type": "string", "format": "date-time",
                      "description": "ISO 8601 timestamp of the last real message. Absent when the transcript holds no datable conversation record; the client falls back to mtime." },
    "mtime":        { "type": "string", "format": "date-time", "description": "Filesystem mtime. Present always; NOT a proxy for activity (#863)." }
  }
}
```

### 7.2 `GET /api/transcripts/migration` — the banner probe

```jsonc
{
  "tags": ["System"],
  "summary": "Whether this instance has transcripts to migrate from own to host",
  "description": "The banner's probe (#882). Answers 'is there anything to migrate?' without classifying anything: it readdirs each project's `.chats/` and the matching host store `~/.claude/projects/<encoded-workingDir>/`, and short-circuits on the first chat id present in the former and not the latter. It never reads a transcript, so it is cheap enough to call on every page load — about 9 ms on a 500-chat instance, memoised per project on `mtimeMs:size` of both directories plus the config version. `eligible` is false with a `reason` when the instance is already on `host`, when `PADDOCK_CLAUDE_TRANSCRIPTS` shadows the config file (the write would be inert), or when nothing is pending. `pendingChats` is a LOWER BOUND, not a total — the probe stops counting once the answer is known; the full count comes from GET /api/transcripts/migration/chats.",
  "response": {
    "200": {
      "description": "Whether a migration is available, and roughly how much.",
      "type": "object",
      "additionalProperties": false,
      "required": ["mode", "eligible", "pendingChats", "pendingProjects", "scannedProjects", "computedAt"],
      "properties": {
        "mode": { "type": "string", "enum": ["own", "host"],
                  "description": "The transcripts mode this process resolved at boot." },
        "eligible": { "type": "boolean",
                      "description": "True when a migration is available to offer. The banner shows if and only if this is true." },
        "reason": { "type": "string",
                    "enum": ["already-host", "env-shadowed", "nothing-pending", "scan-failed"],
                    "description": "Why `eligible` is false. Absent when it is true." },
        "envVar": { "type": "string",
                    "description": "The environment variable shadowing the config file. Present only with reason `env-shadowed`; always `PADDOCK_CLAUDE_TRANSCRIPTS`." },
        "pendingChats": { "type": "integer",
                          "description": "LOWER BOUND on chats that would migrate. Exact only when 0." },
        "pendingProjects": { "type": "integer", "description": "Projects with at least one pending chat." },
        "scannedProjects": { "type": "integer", "description": "Projects examined." },
        "computedAt": { "type": "string", "format": "date-time",
                        "description": "When this answer was computed. May predate the request when served from cache." }
      }
    }
  }
}
```

### 7.3 `GET /api/transcripts/migration/chats` — the table

```jsonc
{
  "tags": ["System"],
  "summary": "Per-chat migration plan, grouped by project",
  "description": "The checkbox table behind the #882 modal. Classifies every chat in every project's `.chats/` against its host store: `new` (no counterpart), `fast-forward` (a counterpart exists and one side is strictly ahead — lossless), `diverged` (both advanced independently). Chats identical on both sides are omitted entirely: there is no decision to make. Classification is staged so cost tracks conflicts, not chat count — a `new` chat is settled by two readdirs, and the fast-forward test is a bounded read at the offset an append-only ancestor's last record must end at, not a scan. Only a genuine divergence costs a full read of the longer file, and those draw from a shared 256 MB budget; rows past it come back `unknown` and default to unchecked, with `scanBudgetExhausted` set. Sweeper stores are migrated silently and appear only as a count. `configVersion` is the value to echo back as `expectedVersion` on POST.",
  "querystring": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "slug": { "type": "string",
                "description": "Optional. Restrict the plan to one project (the root workspace is the empty string). Omit for every project." }
    }
  },
  "response": {
    "200": {
      "description": "The full migration plan.",
      "type": "object",
      "additionalProperties": false,
      "required": ["mode", "configPath", "configVersion", "projects", "sweepers", "totals", "scanBudgetExhausted", "warnings"],
      "properties": {
        "mode": { "type": "string", "enum": ["own", "host"] },
        "configPath": { "type": "string", "description": "Absolute path of the file the POST writes to." },
        "configVersion": { "type": ["string", "null"],
                           "description": "Fingerprint of paddock.config.yaml as read for THIS response; null when the file does not exist yet. Echo as `expectedVersion` on POST to make the write conditional." },
        "projects": {
          "type": "array",
          "description": "One entry per project with at least one row. Projects whose chats are all identical on both sides are omitted.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["slug", "name", "chatsDir", "hostStore", "preserveDir", "chats"],
            "properties": {
              "slug": { "type": "string", "description": "Project slug; the empty string is the root workspace." },
              "name": { "type": "string", "description": "Display name, for the group header." },
              "chatsDir":  { "type": "string", "description": "Absolute path of the source `<project.dir>/.chats/`." },
              "hostStore": { "type": "string", "description": "Absolute destination `~/.claude/projects/<encoded-workingDir>/`. Keyed on workingDir, which for a repo-backed or linked project is the checkout, NOT the project dir." },
              "preserveDir": { "type": "string", "description": "Absolute path unchecked chats are moved to. A SIBLING of `.chats/`, not a child — see DESIGN-transcripts-migration.md §5.1." },
              "chats": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["sessionId", "state", "defaultSelected", "own"],
                  "properties": {
                    "sessionId": { "type": "string", "description": "The chat id. Never rewritten by the migration." },
                    "name":      { "type": "string", "description": "Display name: the chat's set name, else its auto-name. Absent when neither exists." },
                    "preview":   { "type": "string", "description": "First user message, truncated at 100 chars. Absent when unreadable." },
                    "state":     { "$ref": "MigrationState" },
                    "defaultSelected": { "type": "boolean",
                                         "description": "How the checkbox starts: true for new and fast-forward, false for diverged and unknown." },
                    "own":  { "$ref": "MigrationSide", "description": "The copy in `.chats/`. Always present." },
                    "host": { "$ref": "MigrationSide",
                              "description": "The copy in the host store. Absent if and only if state is `new`." },
                    "ahead": { "type": "string", "enum": ["own", "host"],
                               "description": "For `fast-forward`, which side is the descendant and will therefore survive. Absent for other states." },
                    "extras": {
                      "type": "array",
                      "description": "Sidecars that move with this chat: its `<id>/subagents/`, `<id>/tool-results/`, and prefix-matched `.reverts/<id>-*.jsonl`. Listed so the completion summary can be specific about what moved.",
                      "items": { "type": "string" }
                    }
                  }
                }
              }
            }
          }
        },
        "sweepers": {
          "type": "object",
          "additionalProperties": false,
          "required": ["stores", "chats"],
          "description": "Sweeper transcript stores under `<dataDir>/sweepers/<slug>/`. Migrated silently with their project, with no rows and no user choice (#882). Reported as counts only, so the completion summary can mention them.",
          "properties": {
            "stores": { "type": "integer", "description": "Sweeper stores that will be migrated." },
            "chats":  { "type": "integer", "description": "Sweeper transcripts inside them." }
          }
        },
        "totals": {
          "type": "object",
          "additionalProperties": false,
          "required": ["chats", "new", "fastForward", "diverged", "unknown", "identical", "defaultSelected"],
          "properties": {
            "chats":       { "type": "integer", "description": "Rows in `projects[].chats`." },
            "new":         { "type": "integer" },
            "fastForward": { "type": "integer" },
            "diverged":    { "type": "integer" },
            "unknown":     { "type": "integer" },
            "identical":   { "type": "integer", "description": "Chats identical on both sides, omitted from the rows. Reported so a count lower than the user's chat total always has an explanation." },
            "defaultSelected": { "type": "integer", "description": "Rows starting checked — the modal's initial 'N of M'." }
          }
        },
        "scanBudgetExhausted": { "type": "boolean",
                                 "description": "True when the divergence-scan budget ran out and some rows are `unknown`. Never silently true — `totals.unknown` is the count." },
        "warnings": {
          "type": "array",
          "description": "Non-fatal conditions that do not stop the migration but that the modal should surface.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["code", "message"],
            "properties": {
              "code": { "type": "string",
                        "enum": ["host-store-unreadable", "chats-dir-unreadable", "env-shadowed", "unexpected-entries"],
                        "description": "`unexpected-entries` means `.chats/` holds entries that are neither transcripts nor known sidecars; they will still be moved (the postcondition is that `.chats/` ends up empty), but they are named so nothing moves unannounced." },
              "slug":    { "type": "string", "description": "The project it applies to. Absent for instance-wide warnings." },
              "message": { "type": "string", "description": "Human-readable detail, safe to render." },
              "paths":   { "type": "array", "items": { "type": "string" },
                           "description": "Absolute paths the warning concerns, for `unexpected-entries`." }
            }
          }
        }
      }
    }
  }
}
```

### 7.4 `POST /api/transcripts/migration` — execute

Request:

```jsonc
{
  "body": {
    "type": "object",
    "additionalProperties": false,
    "required": ["sessionIds"],
    "properties": {
      "sessionIds": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 0,
        "maxItems": 5000,
        "description": "The chat ids the user TICKED. Everything else in `.chats/` is preserved rather than migrated. An empty array is legal and means 'migrate nothing, preserve everything, and flip the lever' — a real choice, so it is not a 400. Ids not currently in any `.chats/` are ignored and reported under `unknown`."
      },
      "expectedVersion": {
        "type": ["string", "null"],
        "description": "The `configVersion` from the plan this selection was made against. When present, the config write is conditional: 409 `config_conflict` if paddock.config.yaml changed underneath you. Omit to write unconditionally."
      },
      "dryRun": {
        "type": "boolean",
        "description": "Default false. When true, quiesce is skipped, nothing is moved and no config is written; the response reports exactly what WOULD happen. For tests and for a confirm step."
      }
    }
  }
}
```

Responses:

```jsonc
{
  "200": {
    "description": "The migration ran. Check `failed` — a 200 with a non-empty `failed` is a partial migration and the config was NOT written.",
    "type": "object",
    "additionalProperties": false,
    "required": ["ok", "alreadyMigrated", "dryRun", "projects", "migrated", "preserved", "unplanned", "failed", "sweepers", "configWritten", "restartRequired"],
    "properties": {
      "ok": { "type": "boolean", "description": "True when every project reached the postcondition AND the config was written." },
      "alreadyMigrated": { "type": "boolean",
                           "description": "Nothing to do: the stores were already migrated and the config already said host. A repeat POST is idempotent, not an error." },
      "dryRun": { "type": "boolean" },
      "projects": {
        "type": "array",
        "description": "Per-project outcome. Present for every project the migration touched, in the order it processed them.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["slug", "outcome", "migrated", "preserved", "chatsDirEmpty"],
          "properties": {
            "slug": { "type": "string" },
            "outcome": { "type": "string", "enum": ["migrated", "nothing-to-do", "skipped-busy", "failed"],
                         "description": "`skipped-busy` means a turn woke up between the quiesce and this project's moves and it was abandoned untouched (#731)." },
            "migrated":  { "type": "integer", "description": "Chats moved into the host store." },
            "preserved": { "type": "integer", "description": "Chats moved to the preserve dir." },
            "chatsDirEmpty": { "type": "boolean",
                               "description": "Whether `<project.dir>/.chats/` is empty afterwards. FALSE IS A FAILURE — a non-empty `.chats/` means the redirect symlink will not be planted on restart and the project will be half-blind (#708). The config is not written while any project reports false." },
            "error": { "type": "string", "description": "Present only when outcome is `failed`." }
          }
        }
      },
      "migrated":  { "type": "array", "items": { "type": "string" }, "description": "Session ids now in a host store." },
      "preserved": {
        "type": "array",
        "description": "Chats deliberately left behind, with where they went. NOTHING IS EVER DELETED; this array is the recovery path and the completion screen must render it in full.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["sessionId", "slug", "path", "reason"],
          "properties": {
            "sessionId": { "type": "string" },
            "slug": { "type": "string" },
            "path": { "type": "string", "description": "Absolute path of the preserved transcript." },
            "reason": { "type": "string", "enum": ["unchecked", "unplanned-diverged"],
                        "description": "`unchecked` = the user did not tick it. `unplanned-diverged` = it appeared after the plan was built and classified diverged, so its default (unchecked) was applied." }
          }
        }
      },
      "unplanned": {
        "type": "array",
        "description": "Chats present at execute time that were in neither the plan nor `sessionIds` — created between preview and submit. Each was handled by its own classification's default, and is reported so the summary stays honest.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["sessionId", "slug", "state", "action"],
          "properties": {
            "sessionId": { "type": "string" },
            "slug": { "type": "string" },
            "state": { "$ref": "MigrationState" },
            "action": { "type": "string", "enum": ["migrated", "preserved"] }
          }
        }
      },
      "failed": {
        "type": "array",
        "description": "Per-chat failures. A non-empty array means the config was NOT written and the instance is still on `own`; re-running is safe and skips what already moved.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["sessionId", "slug", "reason"],
          "properties": {
            "sessionId": { "type": "string" },
            "slug": { "type": "string" },
            "reason": { "type": "string",
                        "enum": ["destination-exists", "unreadable", "move-failed", "preserve-failed", "unknown"],
                        "description": "Open vocabulary in practice: a client must render an unrecognised value verbatim rather than swallow it, as discoverImport.ts:141-145 already does for adoption reasons." },
            "message": { "type": "string" }
          }
        }
      },
      "sweepers": {
        "type": "object", "additionalProperties": false, "required": ["stores", "chats"],
        "properties": {
          "stores": { "type": "integer" },
          "chats":  { "type": "integer", "description": "Sweeper transcripts migrated silently (#882)." }
        }
      },
      "configWritten": { "type": "boolean",
                         "description": "Whether `claude.transcripts: host` was written. The COMMIT POINT: false means nothing semantically happened and the instance is still resolving `own`." },
      "configPath":    { "type": "string" },
      "configVersion": { "type": "string", "description": "Fingerprint after the write. Present only when configWritten." },
      "restartRequired": { "type": "boolean",
                           "description": "Always true when configWritten. Config is frozen at boot (app.ts:128), so the migration does not take effect until the server restarts — and the chat list stays BLANK until it does, because the running process is still resolving `own` against a `.chats/` the migration just emptied. The completion screen must say so." }
    }
  },

  "400": {
    "description": "`{ error, code }`. `code: \"env_shadowed\"` when PADDOCK_CLAUDE_TRANSCRIPTS is set — env beats the config file, so the write would be inert and the flip would never happen. `code: \"invalid\"` for a malformed session id.",
    "type": "object", "additionalProperties": false,
    "required": ["error", "code"],
    "properties": {
      "error":  { "type": "string" },
      "code":   { "type": "string", "enum": ["env_shadowed", "invalid"] },
      "envVar": { "type": "string" }
    }
  },

  "409": {
    "description": "Nothing was moved and no config was written. `turn_running` — a turn could not be stopped on some chat, so the whole migration refused (a chat left behind would leave `.chats/` non-empty and break the flip for its whole project). `config_conflict` — `expectedVersion` no longer matches. `migration_in_progress` — another execute is already running.",
    "type": "object", "additionalProperties": false,
    "required": ["error", "code"],
    "properties": {
      "error": { "type": "string" },
      "code":  { "type": "string", "enum": ["turn_running", "config_conflict", "migration_in_progress"] },
      "sessionIds": { "type": "array", "items": { "type": "string" },
                      "description": "For `turn_running`: the chats that would not stop. Matches turn-interlock.ts:156-170 exactly, so a client can reuse whatever it already does with that body." }
    }
  }
}
```

### 7.5 Two client-side consequences

- `packages/web/src/lib/api.ts`'s `req()` (`api.ts:41-60`) discards the error
  body's `code`, keeping only `error` as the message. The modal must branch on
  `turn_running` vs `config_conflict` vs `migration_in_progress`, so `ApiError`
  needs a `code` field. Small, and it pays for itself across the four existing
  `turn_running` routes that currently cannot be distinguished either.
- `packages/web/src/lib/types.ts` is hand-maintained ("Kept in sync by hand",
  `types.ts:1-3`). These DTOs get hand-written twin types like everything else;
  the OpenAPI schemas are for external consumers, which is exactly #822's point.

---

## 8. Docs consequences

Beyond what #882 already lists:

- `guides/what-paddock-touches.md:34` says `~/.claude/projects/` is "not read,
  not written" under `own`. The preview reads it. The line needs to become
  something like "not written; read only when you ask for a migration preview".
  `transcripts.ts:180` carries the same claim in a doc comment.
- The preserve location is `<project.dir>/.chats-pre-migration/`, not
  `.chats/pre-migration/` (§5.1), wherever the recovery path is documented.

## 9. Open questions

1. **The quiesce→move window (§4.5).** Narrowed, not closed. Does this warrant a
   fleet-wide "refuse new turns" flag, or is the re-check enough for v1?
2. **Should `paranoid` suppress the banner?** The profile's whole posture is
   isolation (`profiles.ts:167`), and the banner offers to end it. An argument
   exists both ways: an offer is not a change, but a permanent offer to leave the
   posture you chose is a form of nagging — which #882 already rejects for the
   unconditional-banner case.
3. **`memory/` (§5) — move it, or is it out of scope?** It moves under the
   postcondition, and that is almost certainly right (the agent's memory should
   follow the agent). But #882 never mentions it, so it should be a decision
   rather than a side effect.
4. **`promoteSession`'s orphaning of `subagents/` and `.reverts/`
   (`herdctl.ts:1814-1852`)** is a pre-existing bug this design has to route
   around. Fix it in the same change with a shared move helper, or file it
   separately?
