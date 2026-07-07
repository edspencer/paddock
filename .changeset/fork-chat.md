---
"@paddock/server": minor
"@paddock/web": minor
---

feat: fork a chat into an independent child (#77-follow-on)

A **Fork** button on each chat (in the project sidebar, beside Rename/Delete)
duplicates it into a new, independent chat in the same project. The fork is
created **eagerly**: clicking Fork immediately opens a real new chat at
`/chat/<new-id>` with the parent's **full conversation already populated** and
titled **"Fork of <parent>"** — so you can branch a conversation into several
parallel explorations when its context window fills up. The source is left
untouched, and continuing the fork resumes normally.

Server: `POST /api/projects/:slug/chats/:sessionId/fork` copies the session's
transcript into a brand-new session id (rewriting the embedded session id per
line, `cwd` unchanged), names it, writes an attribution job, and invalidates
discovery so it appears immediately — mirroring `promoteScratchSession`, minus
the move/delete. The keeper's `max_concurrent` is lifted from 1 so a project's
chats (and forks) can run in parallel.

Web: the Fork button calls the endpoint, records the parent lineage
(`lib/forkLineage`), refreshes the chat list, and navigates to the new chat
(auto-focusing the composer). The composer footer shows a **"Fork of <parent>"
back-link** to the source chat.

Validated end-to-end against real Claude Code: the copied transcript is a
discoverable, resumable session that continues with the inherited context, and
the source is untouched.
