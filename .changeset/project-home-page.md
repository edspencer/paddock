---
"@paddock/web": minor
---

Add a project **Home** tab — a real landing/overview for each project. Opening a
project (the bare `/projects/:slug`) now defaults to `/home` instead of silently
forwarding into a chat. The Home tab gathers the project summary + metadata
(with an "Edit details" shortcut), recent chats, a preview of the files, and the
CHANGELOG — everything deep-linkable via `/projects/:slug/home` and restorable
via the sticky last-tab. Tabs are now **Home · Chat · Files · Changes**; the
former "Files & Changelog" tab is just **Files** (summary + changelog moved to
Home). This also gives the mobile UI a proper navigation hub.
