---
"@paddock/web": patch
---

perf(web): virtualize large chat transcripts + memo TurnView (large-chat render + typing lag)

The chat transcript rendered every turn into the DOM at once and the per-turn
component was not memoized, so a large chat (a ~500K-token chat is 1000+ turns)
mounted tens of thousands of DOM nodes in one layout on open, and every unrelated
state change (typing in the composer, each streaming chunk) reconciled the whole
transcript.

- `TurnView` is now `React.memo`'d. `turns` are rebuilt only when the message list
  changes, so composer/stream/slash-menu state churn no longer reconciles unchanged
  turns — O(N)-per-keystroke becomes O(changed).
- Large chats (> 80 turns) now window the transcript with react-virtuoso, rendering
  only on-screen turns; initial open + scroll no longer scale with total turn count
  in the DOM. Pin-to-bottom (on open and during streaming) is preserved via
  Virtuoso's `followOutput` + `initialTopMostItemIndex`. Small chats keep the exact
  plain-map path, so behaviour is unchanged for the common case.
