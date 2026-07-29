---
"@paddock/web": minor
"@paddock/server": minor
---

Fold the projects grid into root Home, split instance **Config** from workspace
**Settings**, and fix a phantom scrollbar on the tab strip.

**Navigation.** The sidebar's "New Project" and "New root chat" buttons are
replaced by a single **Home** link to `/`. Both actions live on root Home now —
the projects grid there carries "New Project", and Home's Chats section carries
"New chat" — so the sidebar no longer duplicates them.

**The Projects tab is gone.** The root workspace's tab bar leads with **Home**,
and the projects grid is a *section* of the Home pane rather than a tab of its
own. `/projects` is a permanent redirect to `/`, so links and bookmarks from
v0.51.0 still land on the list. Home's sections read Chats → Projects → Files →
CHANGELOG.md → Overview: Chats lead because that section is on every workspace's
Home, so the page opens the same way whether or not there are children, and
Overview trails because it describes a workspace rather than offering a way into
one. Only a workspace with children renders the Projects section.

**`config` and `settings` are now two different screens, named for the files
they write.** v0.51.0 rendered the instance-wide `paddock.config.yaml` form as a
second section beneath the ROOT workspace's own settings form — two save bars,
one page inside another. They are split:

| | Writes | Lifecycle | Where |
|---|---|---|---|
| **Config** | `paddock.config.yaml` | frozen at boot — restart required | `/config` (sidebar gear) |
| **Settings** | a workspace's `project.yaml` | hot-applied on save | that workspace's Settings tab |

The sidebar's gear is relabelled **Config** and points at `/config`; `/settings`
is the root workspace's Settings tab, now identical to any project's. This also
fixes the tab not scrolling: `InstanceConfigForm` is a fragment whose `min-h-0
flex-1 overflow-y-auto` body only works as a flex-column child, so stacked in a
plain `<div>` it grew to full content height, refused to shrink, squashed the
workspace form to **zero height**, and left nothing on the tab able to scroll.
One pane per tab, and the problem cannot recur.

**No more phantom scrollbar on the tab strip.** `overflow-x: auto` promotes
`overflow-y: visible` to `auto`, so the strip is a vertical scroll container too
— and a scroll container's scrollable area is the union of its descendants'
*border* boxes, which negative margins do not pull in. Each tab's `-mb-px`
(which overlaps the active underline onto the strip's 1px rule) therefore left
1px of scrollable overflow and a scrollbar with nothing to scroll. The -1px now
hangs off the scroller itself, whose parent is not a scroll container: identical
geometry, `scrollHeight === clientHeight`, horizontal tab scrolling intact.
