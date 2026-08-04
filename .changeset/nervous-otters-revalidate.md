---
"@paddock/web": patch
---

Stop the sidebar project list flashing to skeletons on every turn (#572)

`ProjectsProvider.refresh()` set `loading = true` unconditionally, and the
sidebar renders three pulsing placeholders *instead of* the project list
whenever that flag is set. `ProjectView` refreshes the list from three
turn-lifecycle callbacks (`onSessionStarted`, `onSessionEstablished`,
`onTurnComplete`), so the whole nav blanked and re-populated **twice per keeper
turn** — measured on a live instance with a `MutationObserver`.

`loading` was doing double duty: "we have never loaded the list" and "we are
re-checking a list we are already showing". Only the first deserves a
placeholder. It now stays true only until the first *successful* fetch lands;
after that, refreshes revalidate quietly and the previous list stays on screen.
A first load that fails still gets the placeholder back on retry, having nothing
to show in the meantime.
