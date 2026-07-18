---
"@paddock/server": minor
"@paddock/web": minor
---

Hook chat visibility: chat-list filter + hook badge + capability banner (Epic G / G3)

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
