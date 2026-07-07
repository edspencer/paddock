---
"@paddock/web": minor
---

Slim the project chrome on mobile so the chat gets far more vertical space. The
project header collapses to a compact single-row breadcrumb (the project name
links up to the Home tab; the tags, "Overview" badge, "updated" time and summary
are desktop-only now, since they live on Home), and a small "+" starts a new
chat. On the mobile **chat** view the tab bar is hidden entirely — the chat is a
focused view, and the tabs (Home · Chat · Files · Changes) live on the Home hub,
reachable by tapping the project name. At 390×844 this reclaims ~90px: the
header drops 105px→53px and the tab bar (~41px) is gone. Desktop is unchanged
(full header + tab bar).
