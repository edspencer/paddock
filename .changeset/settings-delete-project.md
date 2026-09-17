---
"@paddock/web": patch
---

Add a Delete Project flow to the project Settings tab, and fix the delete
confirmation's copy for linked projects (#923).

Delete used to live in exactly two places, both `ProjectMenu`: the project
header's `⋯` dropdown and the projects-grid card. Neither is reachable from a
keyboard-first reading of Settings, and #919 removes the first of them — which
would leave a user standing inside a project with no way to delete it. Settings
now ends in a **Danger zone** section carrying the action.

The bigger fix is the wording. Both existing dialogs said the project "and all
its chats and files will be permanently removed", which is **false for a linked
project** (#206): `ProjectsService.remove` only ever deletes the project's
metadata directory, so the user's own clone is untouched — deleting *unlinks*.
The confirmation now branches, and the linked variant names the directory that
survives, since that path is the reassurance. All three call sites share one
`DeleteProjectDialog`, so the copy cannot drift apart again, and all three now
run the same post-delete side effects — the grid card previously dropped the
project from the context without clearing its remembered tab.

The Danger zone is **hidden entirely** at the root workspace rather than
disabled: deleting the root is refused server-side, so the UI should never offer
it. The gate is an explicit `isRootKey` check, because the root's slug is the
empty string and every truthiness test on it is right only by accident.

`SettingsPane.tsx` was 1079 lines before this, over the repo's ~1000-line limit.
Its Backing and Derived sections (and the small field primitives they share) now
live in `components/settings/`, bringing it back to 865.
