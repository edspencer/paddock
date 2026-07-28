---
"@paddock/server": major
"@paddock/web": major
---

feat: retire scratch — one-off chats are root chats now (#516 Phase 6, step 2 of 2).

The subtraction half of Phase 6, stacked on the migration that re-homed the
chats. **Do not ship this without that migration**, and not before verifying it:
the migration is reversible on its own, this is not.

Scratch existed because a chat had to belong to *some* agent and there was no
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
  the *only* reason a code path had two branches.
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
  generic. New failure mode, pinned by a test: an unknown *source* project 404s
  and creates nothing.
- **`/chat` is unconditionally a root chat.** It used to fall back to a one-off
  without a root project; it now 404s there, joining `/files`, `/changes`,
  `/history` and `/triggers`. Nothing links to it without a root project — the
  sidebar's chat CTA is hidden in that state.

**Kept on purpose:** `PADDOCK_SCRATCH_DIR` / `cfg.scratchDir`. No agent runs
there any more, but the Phase 6 migration reads `<scratchDir>/.chats` to find the
transcripts it re-homes, so the setting outlives the feature. Documented as
legacy in `CONFIGURATION.md` and relabelled in instance settings.

**Breaking:** every `/api/chats/*` endpoint is gone, as is
`GET /api/commands`. An external client using the one-off API should move to
`/api/projects/__root/chats/*`.
