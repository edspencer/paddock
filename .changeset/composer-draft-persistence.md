---
"@paddock/server": minor
"@paddock/web": minor
---

feat: persist unsent composer drafts per chat (#76)

Typing a message in a chat's composer and switching to another chat — or
refreshing the page — no longer loses the draft. Unsent composer text is now
persisted per chat in `localStorage` (keyed by session id, or `new:<slug>` for a
not-yet-established chat), restored when the chat is reopened, and forgotten once
the message is sent. Mirrors the existing per-chat model-selection persistence
(`lib/chatModel.ts`); storage access is guarded so private-mode / quota errors
never surface.
