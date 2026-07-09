---
"@paddock/server": minor
---

Refresh the model picker: add Fable 5 and Sonnet 5, retire Sonnet 4.6.

`packages/server/src/models.ts` (the single source of truth for the picker,
keeper/sweeper defaults, and context-meter limits) now offers **Opus 4.8**,
**Fable 5** (`claude-fable-5`), **Sonnet 5** (`claude-sonnet-5`), and **Haiku
4.5**. The stale **Sonnet 4.6** entry is replaced by Sonnet 5. Fable 5 and
Sonnet 5 both carry a 1M-token context window (matching Opus 4.8).

The keeper default (Opus 4.8) and sweeper default (Haiku 4.5) are unchanged.
Fable 5 was verified to run on the Max/CLI keeper runtime, so no plan/entitlement
change is required — it's a picker addition only.
