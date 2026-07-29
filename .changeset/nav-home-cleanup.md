---
"@paddock/web": minor
"@paddock/server": minor
---

Fold the projects grid into root Home, and fix two tab-panel layout bugs.

**Navigation.** The sidebar's "New Project" and "New root chat" buttons are
replaced by a single **Home** link to `/`. Both actions live on root Home now —
the projects grid there carries "New Project", and Home's Chats section carries
"New chat" — so the sidebar no longer duplicates them.

**The Projects tab is gone.** The root workspace's tab bar now leads with
**Home**, and the projects grid is the first *section* of the Home pane rather
than a tab of its own. `/projects` is a permanent redirect to `/`, so links and
bookmarks from v0.51.0 still land on the list. Home's sections now read
Projects → Chats → Files → CHANGELOG.md → Overview; Overview moved to the
bottom because it describes a workspace rather than offering a way into one. A
project's Home is unchanged apart from that reorder — only a workspace with
children renders the Projects section.

**The Settings tab scrolls again.** At the root it renders two sections
(workspace settings + instance config), and the second was wrapped in a plain
`<div>`. `InstanceConfigForm` returns a fragment whose `min-h-0 flex-1
overflow-y-auto` body only works as the child of a flex column, so inside that
wrapper it grew to its full content height, refused to shrink, squashed the
workspace-settings form to **zero height**, and left nothing on the tab able to
scroll. The wrapper is now a shrinkable flex column: both sections render and
both scroll.

**No more phantom scrollbar on the tab strip.** `overflow-x: auto` promotes
`overflow-y: visible` to `auto`, so the strip is a vertical scroll container
too — and a scroll container's scrollable area is the union of its descendants'
*border* boxes, which negative margins do not pull in. Each tab's `-mb-px`
(which overlaps the active underline onto the strip's 1px rule) therefore left
1px of scrollable overflow and a scrollbar with nothing to scroll. The -1px now
hangs off the scroller itself, whose parent is not a scroll container: identical
geometry, `scrollHeight === clientHeight`, horizontal tab scrolling intact.
