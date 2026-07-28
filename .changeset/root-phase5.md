---
"@paddock/web": minor
---

feat: History, Settings and Triggers at the root (#516 Phase 5).

The root project now has the full tab bar — there is no tab a project gets and
the root doesn't. History and Triggers needed only routes and un-hidden tabs:
`/api/projects/:slug/runs` and `…/triggers` already resolved through
`projects.get()`, so they worked for `__root` the moment it resolved.

Settings is the one real merge. `InstanceSettings`' editor body is extracted
verbatim into a shared `InstanceConfigForm`, so:

- `/settings` **without** a root project is the standalone admin page, unchanged.
- `/settings` **with** one resolves to the root's Settings tab, showing the
  root's own workspace config (`project.yaml`, hot-applied) above the instance
  runtime config (`paddock.config.yaml`, frozen at boot, restart-required).

They stay two sections rather than being fused, because those lifecycles really
are different and fusing them would hide that.

The root's overflow menu returns with Edit but **without** Delete — `remove()`
refuses the root (its directory IS the projects root), so offering the action
could only ever produce an error. `ProjectMenu.onDelete` is now optional.
