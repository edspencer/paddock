---
"@paddock/web": minor
---

Fork chat: name the fork before creating it (#279)

The fork button used to fork eagerly on click, always titling the copy
"Fork of <parent>". It now opens a small naming dialog first — a single text
input prefilled with that default, auto-focused and fully selected so the user
can hit Enter to accept it or start typing to replace it.

- New `ForkChatModal` follows the existing modal convention (centered card,
  backdrop, Escape-to-close). Enter submits, Cancel/Escape closes without
  forking. A whitespace-only name falls back to the default.
- `ProjectView` opens the dialog instead of forking immediately; the actual
  fork still records lineage (`writeForkParent`) and navigates with
  `justForked` so the composer auto-focuses to continue the new chat.
