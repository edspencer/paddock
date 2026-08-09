---
"@paddock/server": patch
---

`GET <workspace>/chats/attention` now resolves context usage for its **running**
rows.

`AttentionChat` extends `Chat`, so `contextTokens` and `contextLimit` have always
been part of this route's response type — but the handler built its DTOs with no
usage resolver at all, so both were silently `undefined` on every row, forever. A
consumer reading them could not tell "this chat has used no context" from "we
never asked". Nothing in the UI reads them today (Home's running rows show name,
project and time; the chat list's rings come from the separate `/chats/usage`
route), so this fixes no visible gauge — it makes a field that was always empty
carry the value its type promises.

Usage is resolved for the running rows **only**, and that gate is the reason the
resolver was omitted in the first place: usage has no stored counter, it is
derived by streaming a transcript end to end, and this route re-runs on every turn
boundary across the whole fleet. Resolving the unread half would scale with how
much history an instance holds; the running set is bounded by how many turns can
be in flight at once, so the cost tracks live work instead.
