---
"@paddock/web": patch
---

The browser tab's title no longer carries a status prefix (`● `, `✓ `, `(n) `). The favicon dot shows whether a chat is running or has unread replies, so the title is just the page's name. Where the favicon can't be redrawn (a logo image that can't be composited, or no canvas), no status is shown.
