---
"@paddock/web": patch
---

Keep the open chat's sidebar row even when it's momentarily missing from the chat list (#154). The post-turn sweep can transiently steal a live keeper chat's `session_id` (its job gets stamped `sweeper-<slug>`), so `getAgentSessions("keeper-<slug>")` filters that chat out until the next keeper turn re-attributes it — the chat flickers out of the sidebar though it's open and intact (upstream root cause: herdctl#357). `ProjectView` now renders a fallback row for the open `activeSession` when it's absent from the list, preferring its last-seen DTO (real name, ring, actions) and falling back to a minimal "Current chat" row on a cold load, so an open chat can never be left rowless.
