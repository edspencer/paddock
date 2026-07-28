---
"@paddock/server": minor
---

feat: re-home scratch chats onto the root keeper (#516 Phase 6, step 1 of 2).

Since Phase 3, an instance that has a root project serves root chats at `/chat`
— the URL scratch/one-off chats used to occupy. On such an instance every
existing scratch chat became UI-unreachable overnight: transcript still on disk,
nothing routing to it. This is the migration that owes them a home, and it ships
**on its own, ahead of the deletion**, deliberately.

A one-time startup migration (`scratch-migration.ts`, called from `app.ts`
before any sidecar store is constructed) copies `<dataDir>/scratch/.chats/*`
into `<projectsRoot>/.chats/`, adds root-keyed copies of the five sidecar
entries that carry an agent segment (`archive-state`, `star-state`,
`read-state`, `unread-state`, `queued-message`), and points the chats' herdctl
job records at the root keeper. `run-provenance` and `message-provenance` key on
the bare session id, so a re-homed chat keeps its provenance untouched.

**The design doc was wrong about the scope, and the gap was silent.** It listed
the work as "copy the transcripts, re-key five sidecars, two need no touch".
Doing exactly that, against a copy of the live data, produces a chat list with
**zero** entries — everything is on disk in the right place and nothing lists.
The missing piece is herdctl's session attribution index, built from the
`job-*.yaml` records in `<stateDir>/jobs/`: a session belongs to the agent its
job records name, and a re-homed chat's still said `scratch`.
`promoteScratchSession` has always had to do this (`reattributeSession`); the
design doc simply did not carry it over. Nothing in the type system or the tests
would have caught it — only booting the thing did.

That step is the one part that is not purely additive, and it cannot be:
herdctl assembles the index by iterating job files in completion order,
last writer wins, so adding a `keeper-__root` record *alongside* the `scratch`
ones attributes the session nondeterministically. Only records whose agent is
exactly `scratch` and whose session was re-homed are rewritten; a chat with no
job records at all gets a synthesized adoption record.

**Otherwise purely additive.** It copies transcripts, never moves them; adds
sidecar keys, never removes or overwrites. `<dataDir>/scratch/` is left
byte-for-byte intact and the scratch routes are still in this build, so if the
migration is wrong the source data is still the source data. That is the entire
reason for the two-PR split — shipping the migration and the deletion together
would mean a wrong migration leaves the chats unreachable *and* deletes the code
that could reach them.

**"34 scratch transcripts" is 7 chats.** 27 of the 34 are `agent-*.jsonl`
sidechain (subagent) transcripts, which herdctl never lists as sessions. They
are copied — a chat's subagent pane reads them — but never given a job record,
or the chat list fills with rows that resolve to nothing.

**Gated on the root project existing**, like the rest of #516: no
`<projectsRoot>/project.yaml` ⇒ `/chat` still serves scratch, nothing is
stranded, and this is a no-op. Every instance that has not opted in is
unaffected.

**Idempotent**, so it is safe on every boot: a transcript already at the
destination is skipped and a key already present in re-keyed form is skipped.
The destination state is the marker — no marker file, no version stamp.

Two details that were easy to get wrong and are pinned by tests:

- The five sidecars do **not** share one key arity. `archive`/`star`/`queued`
  are `<agent>\0<sessionId>`, but `read-state`/`unread` are
  `<user>\0<agent>\0<sessionId>` when a user identity is present. A
  `startsWith("scratch\0")` rewrite silently misses every user-keyed entry —
  which is most of them on an authenticated instance. What is invariant is that
  the agent is the **second-to-last** segment, so the rewrite matches on
  position, not prefix. (Verified by mutation: swapping in the naive `startsWith`
  version fails five of these tests.)
- A re-homed transcript's recorded `cwd` still says the scratch dir, and nothing
  rewrites it. That was the open risk — `promoteScratchSession` rewrites `cwd`
  as it copies, so it was a near-miss precedent rather than proof. **Verified
  empirically, twice, against copies of the real transcripts.** First at the CLI
  level: a transcript recording `cwd: /var/lib/paddock/scratch`, copied
  elsewhere and resumed from an unrelated directory, resumed and recalled a
  codeword from its pre-move turns. Then end to end through Paddock: a second
  re-homed chat, opened at `/chat/<id>` on a dev instance with a root project,
  resumed as `keeper-__root` from `<projectsRoot>` and answered its pre-move
  codeword correctly; the new turns record the new `cwd` while the old ones keep
  the old. Claude Code keys resume on the transcript's location, not its
  recorded `cwd`.
