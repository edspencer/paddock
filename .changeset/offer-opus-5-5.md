---
"@paddock/server": minor
---

Offer Claude Opus 5.5 (`claude-opus-5-5`) in the model picker and make it the instance default, replacing Opus 5. It is both newer and cheaper — $4/$20 per MTok against Opus 5's $5/$25, with cache reads at 0.05× base input rather than the standard 0.1× — so a project that has not pinned a model gets a better model for less. Opus 5, Opus 4.8, Fable 5.1, Fable 5, Sonnet 5 and Haiku 4.5 all stay in the catalog, so every existing per-project pin keeps resolving.

If your instance sets a `models:` allow-list that names an older Opus explicitly, nothing moves: the new default is not in your list, so projects continue to fall back to the first offered model in catalog order. Add `claude-opus-5-5` to the list when you want it.

Also corrects Sonnet 5's pricing from $3/$15 to $2/$10. The $2/$10 launch price was announced as introductory through 2026-08-31, but the scheduled 2026-09-01 increase to $3/$15 was cancelled and $2/$10 became the standard price. We had encoded the increase, which overstated the estimated cost of every Sonnet 5 chat by 50%.
