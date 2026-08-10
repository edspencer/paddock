---
"@paddock/web": minor
---

Discover: the view (#745, web half). A **route**, `/discover`, that lists the
directories on this machine with existing Claude Code history and imports the
ones you tick as projects — and the empty instance's Home, which renders the same
component inline.

One component, two mount points. Not a dialog: a fresh instance whose Home *is*
Discovery has nothing to dismiss, so there is no "don't ask again" flag to get
wrong, and a first-run screen you can link to and refresh is the one that
survives being booted from launchd with nobody at a terminal (#796). "Empty"
means zero non-root projects **and** zero root-workspace chats — the root always
exists, so it cannot be what makes an instance non-empty, but a conversation
started in it means the instance is in use. A `Discover` entry joins `Config` in
the sidebar footer.

The table is one row per candidate: path, git remote, conversation count, how
many the noise filter withheld, and the newest session's date. Tickboxes are
**tri-state** — a directory with only some conversations ticked shows
indeterminate — and rows expand **lazily**, fetching
`GET /api/discover/sessions` only when opened, so a collapsed table costs
nothing. Everything is ticked by default. The two soft rules (`no git`, `outside
$HOME`) are offered as toggles, but only when relaxing one would actually reveal
something; `scanned: 0` says there is no history at all and names the Claude home
to bind-mount, rather than rendering an empty table that looks broken; and a
candidate whose transcripts record a *different spelling* of its path is warned
about up front, that being how an import silently comes back empty.

Importing is two existing calls per row — `POST /api/projects` then
`POST …/adopt-chats` — run sequentially from the client, with no new streaming
protocol. Submit disables on submit, and each row colours itself as its own calls
resolve. Failures are **per row** and carry their own sentence: create-failed is
red, and the one that matters — created-but-import-failed, which leaves a real
empty project behind — is amber and says so, as is a clean run that imported
nothing. `skipped` reasons are surfaced per row rather than rounded away. On
completion a success panel offers **Get started**, which refreshes the project
list and returns to Home — no longer empty, so it renders the ordinary workspace.

Also: the shared `Checkbox` primitive gained an `indeterminate` prop (a DOM
property with no attribute, so it cannot be set from JSX), which sets
`aria-checked="mixed"` with it.
