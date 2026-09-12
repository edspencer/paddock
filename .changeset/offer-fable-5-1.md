---
"@paddock/server": patch
---

Offer Claude Fable 5.1 (`claude-fable-5-1`) in the model picker. It supersedes Fable 5, which stays in the catalog so existing per-project pins keep resolving. `ModelPricing` gains an optional `cacheReadMultiplier` because Fable 5.1 reads cached tokens at 0.025× the base input price rather than the standard 0.1× — cache reads dominate a long chat's token counts, so the shared multiplier would have overstated a Fable 5.1 chat's estimated cost roughly fourfold.
