---
"@paddock/server": patch
---

Bump `@herdctl/chat` (0.4.6 → 0.4.8) and `@herdctl/core` (5.14.1 → 5.15.1) to
pick up the synthetic-message fix (herdctl #293 / #294). After a `/compact`, the
Claude Code CLI emits a synthetic `"<synthetic>"` placeholder assistant turn
("No response requested.") at the head of the next turn; herdctl now filters
those in both the live SDK-message translator and the transcript parser, so the
placeholder no longer streams into the chat before the real reply — nor renders
as a bubble when the chat is reopened.
