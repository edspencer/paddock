---
"@paddock/web": patch
---

fix(web): roll back transcript virtualization (broken scrolling); keep memoized TurnView

The react-virtuoso windowing added in #148 broke scrolling back through history on
real, variable-height chats (markdown, code blocks, tool blocks). As tall bubbles
were measured on scroll, Virtuoso's total height estimate kept ballooning (measured
~22k → ~37k px on a 350-turn chat) and the scroll position jumped — scrolling *up*
would snap the viewport *down*. Initial open was fine, but reading history was
janky/unusable.

Reverted to the plain, reliable transcript list (single scroll container, stable
scroll height, precise scroll position) and removed the `react-virtuoso`
dependency. **`React.memo(TurnView)` is kept** — it's the change that fixes
composer-typing / streaming lag and is unaffected by the scrolling problem. The
large-chat open cost this was meant to address is now largely covered by the
server-side wins in 5.19.1 + Paddock #147 (message/subagent mtime caches), so the
plain list performs acceptably while scrolling correctly.
