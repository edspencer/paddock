---
"@paddock/web": patch
---

fix(web): persist the queued message so it survives a chat switch / reload (#197)

The message queue (#91) kept its single stacked follow-up only in component-local
React state, so navigating away from a chat and back — or refreshing — silently
dropped it (surprising, since the composer draft right beside it already
persists). The queued message is now stored per-chat in localStorage, keyed like
the draft (`new:<slug>` before a session id exists, the session id after),
hydrated when the pane remounts, and forgotten when the queue flushes / is edited
/ is cleared. A restored queue still auto-flushes on the next completed turn.
