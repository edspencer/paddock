---
"@paddock/server": patch
---

fix(#329): stop rendering a false "The turn failed" banner beneath a perfectly good reply

The turn-notice classifier (#361/#329) treated a terminal `result` message with
`is_error: true` as a turn failure. But `SDKResultSuccess` is typed
`is_error: boolean`, and the runtime stamps `is_error: true` on a
`subtype: "success"` result when a session-mode turn RECOVERS from a transient
mid-turn API error (e.g. "Connection closed mid-response") and still produces a
normal reply. That fired a red error banner + Retry beneath essentially every
successful session-mode turn.

`classifyResult` now keys off the authoritative signal — an `error_*` `subtype`
(or an explicit `success === false`) — exactly matching `@herdctl/core`'s own
success computation, so Paddock never disagrees with herdctl about whether a
turn failed. A bare `is_error: true` with no subtype is still treated as an error
(defensive). Genuine usage-limit, max-turns, and API/error results are unchanged.
