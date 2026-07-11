---
"@paddock/web": patch
---

Fix concurrent new chats fusing together (#142).

Starting a second new chat while the first was still streaming its opening turn could queue the second message into the first chat's live turn — fusing the two — and create no second chat in the sidebar. Two web-side defects:

- **Pane reuse during the establish race** (`ProjectView`): the `ChatPane` remount key was derived only from `routeSessionId` transitions. A brand-new chat mirrors its learned session id into the URL asynchronously (`/chat` → `/chat/:id`, `replace`); clicking **New Chat** before that landed left `routeSessionId` null, so the key didn't bump and the still-streaming pane persisted — the next message was queued into that live turn. New Chat now forces a genuinely fresh pane via a nonce, independent of the establish race.
- **Straggler frame leak** (`ws.route()`): a still-streaming chat whose pane had unmounted had its frames (a *known* session id) handed to a freshly-mounted new-chat subscription. Known session ids are now tracked, and a frame for a known session with no live subscriber is dropped rather than routed to a nascent new-chat pane; a brand-new chat's own (as-yet-unknown) first session reveal still reaches it.

No server or protocol changes.
