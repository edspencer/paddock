---
"@paddock/server": patch
---

Fix the composer context meter under-reporting context by dropping cache tokens (#165). The live `chat:complete` usage now keeps the usage block with the largest context snapshot instead of the last non-null one, so the terminal cache-less result message no longer clobbers the assistant block's cache reads.
