---
"@paddock/server": minor
"@paddock/web": minor
---

feat(chat-list): nest chats under the chat that created them.

The sidebar was flat, so a keeper fanning out a dozen children via `create_chat`
produced a dozen unrelated-looking rows. Provenance (#267) recorded that a chat
was `spawned` and how deep, but never *by whom* — the list could badge a child
yet not file it under its parent. Now it can.

- **Server:** `RunProvenance` gains `parentSessionId`/`parentProject`, recorded at
  creation. `fork_chat` stamps its *source* as the parent, and the UI fork route —
  which previously stamped no provenance at all, leaving hand-forked chats
  indistinguishable from human roots — stamps it too. Chats created before the
  field existed backfill from `MessageProvenanceStore`: a spawned chat's kickoff
  prompt was injected *by* its parent, so the first `chat`-kind sender marker is
  the parent. Both are in-memory sidecars, so the resolver is cheap enough to run
  per row. The edge surfaces on the chat DTO as `parent`.
- **Web:** `buildChatTree`/`flattenTree` turn the flat list into a forest, with a
  twisty, guide lines, and a count pill on collapsed parents. Three flat-list
  behaviours don't survive nesting unchanged: subtrees now sort by their *newest
  descendant* (mtime-desc alone strands a parent below its own fresh children),
  starring floats within a sibling group rather than globally (which would tear a
  starred child out from under its parent), and search keeps a match's ancestors
  and overrides collapse (else a folded-up parent hides the very chat you searched
  for). A parent outside the visible set — cross-project, archived, filtered —
  renders as a root rather than swallowing its children.

Chats start expanded: nesting only re-orders and indents rows already in the list,
so collapsing by default would hide chats that are visible today. Collapse state
persists per project, per browser.
