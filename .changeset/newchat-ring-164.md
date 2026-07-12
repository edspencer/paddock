---
"@paddock/web": patch
---

Show a brand-new chat's context-usage ring in the chat list immediately after its first turn, instead of only after a full page refresh (#164). The ring is now seeded from the live `chat:complete` usage the pane already holds, so it no longer depends on a same-instant, mtime-memoized disk re-read that can race and omit the new session.
