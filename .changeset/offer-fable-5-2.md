---
"@paddock/server": patch
---

Offer the three newest Claude models in the picker: **Fable 5.2** (`claude-fable-5-2`, $8/$40, 0.025× cache reads), **Sonnet 5.5** (`claude-sonnet-5-5`, $2/$10, 0.05× cache reads) and **Haiku 5.5** (`claude-haiku-5-5`, $0.10/$0.50). Each supersedes a model that stays in the catalog, so existing per-project pins keep resolving, and the default is unchanged (Opus 5.5).

Note that Haiku 5.5 is a **1M-context** model, unlike the 200K Haiku 4.5 it supersedes — the model-picker hint no longer says Haiku means 200K. Its cost estimate is pinned at the base (≤100k-prompt) tier: Haiku 5.5 is the one model priced by prompt length, and a chat's cumulative token totals can't distinguish the tiers, so a long Haiku 5.5 chat is under-estimated. Tracked separately.
