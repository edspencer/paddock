---
"@paddock/web": patch
---

docs(website): bring the **What's New** page up to date through v0.44.

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
