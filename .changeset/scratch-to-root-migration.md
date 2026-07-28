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
into `<projectsRoot>/.chats/` and adds root-keyed copies of the five sidecar
entries that carry an agent segment: `archive-state`, `star-state`,
`read-state`, `unread-state`, `queued-message`. `run-provenance` and
`message-provenance` key on the bare session id, so a re-homed chat keeps its
provenance untouched.

**Purely additive.** It copies, never moves; adds keys, never removes or
overwrites. `<dataDir>/scratch/` is left byte-for-byte intact and the scratch
routes are still in this build, so if the migration is wrong the chats are still
reachable the old way and the source data is still the source data. That is the
entire reason for the two-PR split — shipping the migration and the deletion
together would mean a wrong migration leaves the chats unreachable *and* deletes
the code that could reach them.

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
  empirically on a throwaway copy:** a real scratch transcript recording
  `cwd: /var/lib/paddock/scratch`, copied elsewhere and resumed from an
  unrelated directory, resumed cleanly and recalled a codeword from its pre-move
  turns. Claude Code keys resume on the transcript's location, not its recorded
  `cwd`.
