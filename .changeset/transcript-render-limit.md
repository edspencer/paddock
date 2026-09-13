---
"@paddock/server": minor
"@paddock/web": minor
---

Cap how many messages a chat transcript renders, so opening a long-running chat
is fast (#914).

A chat going for days reaches a few thousand messages, and mounting every one of
them is what made switching into it slow. The transcript now renders the most
recent `ui.transcriptRenderLimit` messages (default **500**; `0` = no limit),
applied at the `/messages` join so the older ones are never fetched, parsed or
mounted. Set it in `paddock.config.yaml`, from Settings → Interface, or with
`PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT`.

Nothing is deleted — this is a render budget, not a retention policy. The
transcript says how many earlier messages it is not showing, and a deep link to a
message above the cap still resolves (the full transcript is fetched for that
case rather than claiming the message is gone).

`GET /chats/:sessionId/messages` grows an optional `?limit=` and returns `total`
+ `truncated` alongside `messages`. The default is unchanged and uncapped, so
existing API consumers are unaffected.
