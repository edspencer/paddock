---
"@paddock/web": minor
"@paddock/server": minor
---

Expanding a tool call's card now shows its full input, one row per argument, instead of only the truncated one-line summary, for any tool without a dedicated view such as an edit's diff. Multi-line commands and prompts keep their line breaks; very long values are cut with a marker saying how much was left out.
