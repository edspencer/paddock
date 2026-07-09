---
"@paddock/server": patch
"@paddock/web": patch
---

perf: don't block the project view on per-chat context-usage rings (#116)

Switching into a project scaled with its chat count (2–3s on chat-heavy
projects) because `GET /api/projects/:slug` computed a context-usage ring for
every chat, and each ring streams+parses that chat's entire transcript. The
whole ProjectView waited on this.

The chat list and project detail now come back usage-free (from cached
name/preview/mtime), so the view renders immediately. A new
`GET /api/projects/:slug/chats/usage` endpoint returns the per-chat usage map,
which the client fetches separately and merges into the sidebar rings after the
view has rendered (and again after a turn completes). Behavior is otherwise
unchanged — the rings still show the same fill.
