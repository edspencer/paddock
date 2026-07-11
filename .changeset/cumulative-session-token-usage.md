---
"@paddock/server": minor
"@paddock/web": minor
---

feat(usage): per-chat cumulative token consumption + cost estimate

The context ring/meter only ever showed the *last turn's* context-window fill
(`input + cache_read + cache_creation`), never how many tokens a whole chat has
consumed. A new server-side transcript extractor (`usage.ts`) sums every
assistant turn's input, output, cache-read and cache-creation tokens (deduped by
message id, like core) and prices them at first-party API list rates — output,
cache-write (1.25× input) and cache-read (0.1× input) each priced separately, so
the figure neither double-counts the growing context nor misprices output.

The `ChatUsage` DTO (bulk `/chats/usage` + per-chat `/context`) now carries the
cumulative totals and a `costUsd` estimate alongside the existing context-fill
fields. The chat-list usage ring tooltip and the in-chat status row surface a
"session so far" summary (e.g. `1.25M tokens · 910K in / 340K out · ~$4.10 at
API rates`); the in-chat figure refreshes after each completed turn. On the
Max/CLI runtime this cost is informational (no per-token quota) — the token
counts are the honest metric, and `costUsd` is null for a model with no known
pricing. No `@herdctl/core` changes.
