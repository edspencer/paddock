---
"@paddock/web": patch
---

Stop Settings claiming an instance default it hasn't fetched yet

A project's Settings tab seeded the three inherited instance defaults with
literals, so before `GET /api/models` returned it told you your box defaults to
drive mode **Batch** — a claim about instance configuration, and a wrong one:
the box-wide default has been `session` since v0.36. The literal was written
when `batch` was the default and was never updated, which is exactly the drift a
hard-coded copy invites (#587).

The pre-fetch state is now genuinely unknown (`null`) rather than a guess, and
renders as such: `Global default (loading…)`, `Instance default (loading…)` and a
short "Loading the …" hint in place of the "Inheriting …" prose, matching the
existing *"Loading the instance model list…"* idiom in the same pane. Applied to
drive mode, max spawn depth and the curation budgets alike, so none of them can
drift the next time a server default changes. Nothing about what is persisted
changes — the placeholder was never saved.
