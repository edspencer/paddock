---
"@paddock/server": minor
"@paddock/web": minor
---

feat: fork a chat into an independent child (#77-follow-on)

A **Fork** button on each chat (in the project sidebar, beside Rename/Delete)
branches a new chat from the source's full context. The first message you send in
the fork resumes the source session's transcript but writes to a brand-new
session id (Claude Code's `--fork-session`, surfaced through
`@herdctl/core@^5.15.0`), leaving the original untouched — so you can spin one
chat into several parallel explorations when its context window fills up. Works
even while the source is still streaming.

Server: `chat:send` accepts `forkFrom` (first turn of a new chat only) and threads
it to `herdctl.chat({ fork })`. The keeper's `max_concurrent` is lifted from 1 so
a project's chats (and forks) can run in parallel. Web: a `forkFrom` router-state
flow opens a fork composer; the WS client + `ChatPane` send `forkFrom` on the
first turn and clear it once the child establishes its own id.

Requires `@herdctl/core@^5.15.0` (adds `TriggerOptions.fork`).
