---
"@paddock/server": minor
"@paddock/web": minor
---

Event hooks foundation: run an agent turn when a lifecycle event fires (Epic G / G1)

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
