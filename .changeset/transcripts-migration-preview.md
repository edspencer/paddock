---
"@paddock/server": minor
---

Migration preview API (#882): two read-only endpoints that answer "is there
anything to migrate from `own` to `host`, and what exactly would happen?"

`GET /api/transcripts/migration` is the banner's probe — one `readdir` per
project, memoised on the directory's own `mtimeMs:size`, cheap enough to call on
every page load. `GET /api/transcripts/migration/chats` is the modal's table:
every chat in every project's `.chats/`, classified against the user's own
transcript store as `new`, `fast-forward` or `diverged`, with the sidecars
(`subagents/`, `tool-results/`, prefix-matched `.reverts/`) and the project-level
artifacts (`memory/`, flat sidechain transcripts) named alongside them.

Nothing moves, nothing is written, and no config is touched — that is the next
change. Both endpoints publish complete JSON Schema rather than the house
`additionalProperties: true`, so the generated OpenAPI document actually
describes them (#822).

Note the posture change this makes, narrow and deliberate: under `transcripts:
own` Paddock has never read `~/.claude/projects/`, and the preview must, because
a net-new chat and a chat that has diverged from a CLI original are
indistinguishable without comparing the two. It reads only when you ask for the
preview, it never writes, and the two places that promised otherwise now say so.
