---
"@paddock/server": patch
"@paddock/web": patch
---

**The root workspace's Home is now the instance's onboarding surface** (#865).

A brand-new install dead-ended on its own front door. `/` rendered Discovery
_instead of_ the workspace whenever the instance was empty — and on a machine
with no Claude Code history, Discovery's adopt footer and its "Get started" exit
are each gated on something that can never happen. The result was a front door
with no button anywhere on it, under copy telling a first-time user that every
directory with history "is already a project, or was filtered out".

- **The takeover is gone.** `/` is always the root workspace. While the instance
  is empty its Home carries Discovery inline, full width, at the top, and
  suppresses the running/unread widgets entirely — zero chats means neither can
  say anything true. `/discover` as a standalone route is unchanged.
- **Two cards on the root's Home: What's New and Tips.** Each shows one entry,
  chosen at random on every landing, with a shared pager to step through the
  rest. Permanent furniture rather than first-run scaffolding, and deliberately
  stateless — no seen-tracking, no history, nothing to dismiss.
- **Home gained a responsive layout.** At XL, OVERVIEW.md and CHANGELOG.md sit
  side by side, and the feeds and the two cards are half-width. Below XL it is
  the single column it has always been.
- **Paddock's own `.chats` bridges no longer count as scanned transcript
  folders.** They are planted at boot, so `GET /api/discover` reported
  `scanned: 2` on a machine that had never run Claude Code — which made
  `scanned === 0`, and the honest "no history here" copy written for exactly that
  case, unreachable.
- The first-run lead no longer asserts you have "probably already been using
  Claude Code in a terminal", and the fleet bar's "No turns yet — start a chat →"
  points at `/chat` rather than back at the page it is written for.

No new configuration. An earlier revision of this branch added a
`gettingStartedDismissed` instance-config key to close a Getting Started
slideshow; the slideshow is not shipping, so the key is gone with it and nothing
on Home is closeable. The key never appeared in a release, so its removal is not
a schema change.
