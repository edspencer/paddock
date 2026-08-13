---
"@paddock/web": patch
---

Deep-link to a single message. The per-message hover rail's time/context pill is
now a link to that message: click it to copy the URL, and opening that URL loads
the chat scrolled to the message with a brief flash. It's a real anchor, so
⌘/Ctrl-click and "Copy link address" work, and the row carries a matching DOM id.
A link whose target has been reverted away says so instead of doing nothing.
