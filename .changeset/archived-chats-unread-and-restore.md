---
"@paddock/web": patch
"@paddock/server": patch
---

Archived chats no longer count as unread, and are left out of the chat list's unread dots. The sidebar badges and the fleet strip drop a chat the moment it is archived, and a reply landing in an already archived chat no longer counts towards them; it still shows as running while its turn is live. Returning to a project restores the last opened chat that is still active, never an archived one, falling back to a new chat when none is. The Archived section now opens only when you open it: when the chat you are on is archived, it shows just that chat's row under the collapsed header.
