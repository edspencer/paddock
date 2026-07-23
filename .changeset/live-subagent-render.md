---
"@paddock/server": minor
"@paddock/web": minor
---

Background sub-agent cards now render live, without a refresh.

Building on the background-work delivery in the previous release, a `Task`/`Agent` sub-agent's card is now enriched the instant it launches — instead of showing a generic launch acknowledgement until the chat is reloaded.

- **Real type + title, live.** The sub-agent's type (e.g. `general-purpose`) and description are recovered from the tool call's input as it streams and shown on the card immediately.
- **Running state.** A still-working sub-agent shows a running spinner in place of its near-instant launch time — including a background sub-agent whose launch call has already returned but whose own run continues.
- **Streaming inner steps.** Expanding a running sub-agent now streams its nested steps as they happen (polled from the growing sub-agent transcript), recursing into nested sub-agent launches at any depth.
- Enrichment is applied across every turn path (interactive chat, scheduled wake, and slash-command turns), and the reload view is unchanged.

Known cosmetic limitations, tracked as follow-ups: a nested (depth 2+) launch shows a generic label until it completes; a running sub-agent's duration and cost appear once it settles or on reload; and reloading while a background sub-agent is still running shows a partial duration rather than the running state.
