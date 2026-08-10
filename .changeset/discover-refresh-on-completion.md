---
"@paddock/web": patch
---

Discover: imported projects now appear without a manual browser reload (#808)

The first-run import run refreshes the project list the moment it finishes, so
the sidebar matches the success screen's own claim that "they are in the sidebar
now" — previously the list was refetched only by the **Get started** button, and
anyone who read the result and looked at the sidebar saw an instance that still
said "No projects yet".

Home's empty-instance decision is now latched for the life of the mount and
released by **Get started**, so that refresh cannot unmount the screen reporting
the run: the success headline and every per-row outcome — including the rows that
failed and have something to say about it — stay on screen until the user leaves.
