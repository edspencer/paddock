---
"@paddock/web": minor
---

feat: search the chat list from a compact search field (#96)

Replaces the full-width **New Chat** button above the chat sidebar with a
**search input + a compact square `+` button** (plus icon only). Typing filters
the chat list live — a case-insensitive substring match over each chat's name
and its first-message preview — with the count badge showing `matches/total`
while filtering. A clear (`×`) button and a "No chats match" empty state round
it out; the `+` button behaves exactly as New Chat did before. Filtering is
fully client-side (the list is already in memory), so there is no server
round-trip.
