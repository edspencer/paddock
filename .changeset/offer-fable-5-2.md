---
"@paddock/server": patch
---

Offer Claude Fable 5.2 (`claude-fable-5-2`) in the model picker. It supersedes Fable 5.1, which stays in the catalog alongside Fable 5 so existing per-project pins keep resolving. Fable 5.2 is priced at $8/$40 per million tokens (20% under Fable 5.1) and keeps Fable's 0.025× cache-read rate, so a chat's estimated cost reflects the lower price. The default model is unchanged (Opus 5.5).
