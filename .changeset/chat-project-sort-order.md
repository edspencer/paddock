---
"@paddock/server": minor
"@paddock/web": minor
---

The chat list and the project list can now be sorted by **Most recent reply** (the default), **Created**, or **Manual**. In Manual, drag a chat or project to reorder it, or focus it and press Alt+Arrow Up/Down; dragging a project onto another area moves it there. The sort mode and manual order are stored on the server, so they follow you across devices.

The default **Most recent reply** order of the chat list now goes by each chat's last completed turn (falling back to its last update when it has none) rather than its transcript file's modification time.
