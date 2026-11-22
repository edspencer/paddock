---
"@paddock/server": minor
"@paddock/web": minor
---

After each turn, a cheap model now judges whether a chat looks finished or whether you could continue it, and the verdict shows as a mark on the chat's row in the sidebar and on Home, with its one-line reason on hover. Chats you could continue are counted in the sidebar's project badges and the fleet strip. The verdict updates live and disappears when the chat moves on, until the next turn is judged. On by default; turn it off with `PADDOCK_JUDGE_ENABLED=false` (config-file `judge.enabled`), and pick the model with `PADDOCK_JUDGE_MODEL` (`judge.model`).
