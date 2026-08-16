---
"@paddock/server": minor
---

Offer the `own → host` transcript migration in the fleet readout (#882).

Paddock's default keeps a project's chats in its own `.chats/` rather than in
your `~/.claude`, which is the right default for trying it and the wrong one for
keeping it: nothing you do in Paddock shows up in `claude --resume` from a
terminal. #882 is the one-button path between the two, and until now there was
nothing anywhere in the UI that told you the path existed.

A chip now sits in the empty space at the right of the top strip —
`Chats are separate from ~/.claude · Merge` — shown if and only if
`GET /api/transcripts/migration` reports the instance eligible. It is
dismissible, and dismissing it says where the offer went; the Config screen
carries the same offer permanently, which is also the only place a `paranoid`
instance is offered it at all. Instances already on `host`, on a shadowing
`PADDOCK_CLAUDE_TRANSCRIPTS`, or with nothing pending see the strip exactly as
it is today.

The migration modal itself — the per-chat new / fast-forward / diverged table
and the POST that executes it — is the next PR. Clicking the offer today opens a
dialog that says so and touches nothing on disk.
