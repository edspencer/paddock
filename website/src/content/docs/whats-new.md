---
title: What's New
description: "The user-facing highlights of each Paddock release — the instance's own root as a first-class workspace, subtree actions on the chat tree, a running-chats filter, instance Config split from workspace Settings, scratch retired, a much faster jobs index, a chat list that nests spawned chats under their parent, an external MCP endpoint, a generated API reference, per-message fork & revert, Claude Opus 5 by default, official Docker images & deploy recipes, attachments, streaming, unified triggers, and more."
---

The headline changes in recent Paddock releases, newest first. These are the
things you'll *notice* — not an exhaustive changeset. For the full, per-package
detail see the changelogs on GitHub
([server](https://github.com/edspencer/paddock/blob/main/packages/server/CHANGELOG.md),
[web](https://github.com/edspencer/paddock/blob/main/packages/web/CHANGELOG.md)).

:::note[Reading older entries]
Each entry describes a release as it shipped, and some things were refined later.
The separate `set_schedule` and `set_hook` self-management tools below were unified
into a single `set_trigger` family in a subsequent release. And 0.49's root
*project* — reached through a reserved `__root` slug — was replaced two releases
on by 0.51's root **workspace**, whose key is the empty string and whose routes
live at `/api/root`; `__root` is no longer accepted anywhere. Where a superseded
detail would otherwise send you to an address that no longer resolves, the entry
says so inline.
:::

Two arcs run through the most recent stretch. The first is that Paddock's own
**root** stopped being a hole in the model: the directory holding your projects is
now a workspace in its own right — with a keeper, chats, files, changes, history,
triggers and settings, exactly like a project — which retired the old
second-class "scratch" chat and turned `/` into somewhere you work rather than a
menu you pass through. The second is that the **chat list** grew up. A fan-out
used to arrive as a flat pile of rows; it now nests under the chat that caused it,
folds away, tells you which of its chats are working right now, and lets you
archive or delete a whole family in one gesture.

Before those, a longer arc: Paddock grew from a place to *chat with*
agents into a place where agents **run on their own** — fired by events and
schedules, spawning and reporting back to each other — with the UI making all
that unattended work legible at a glance. With 0.46 the boundary opens the other
way as well: Paddock is now something you can **drive from outside**, over an MCP
endpoint and a published HTTP API, carrying its own credentials and its own
read-only-by-default policy rather than borrowing your proxy's. An instance is
becoming less an app you visit and more a service your other tools talk to.

## 0.52 — Subtree actions & one front door

- **The sidebar is one Home link, and the projects grid lives on it.** The two
  buttons that used to sit in the sidebar — **New Project** and **New root chat** —
  are gone, replaced by a single **Home** link to `/`. Both actions moved to where
  the thing they create actually lives: the projects grid on root Home carries
  **New Project**, and Home's Chats section carries **New chat**. The **Projects**
  tab is gone too — the grid is now a *section* of the Home pane rather than a tab
  of its own, so the instance's front door is one page instead of a choice between
  two. Home's sections read Chats → Projects → Files → CHANGELOG.md → Overview:
  chats lead because every workspace has them, so the page opens the same way
  whether or not it has children, and the overview trails because it describes a
  workspace rather than offering a way into one. Only the root gets a Projects
  section, since it's the only workspace with children today. Old links and
  bookmarks still work — `/projects` now lands you straight on `/`.

![The sidebar reduced to a single Home link above the Projects list, with the Config gear sitting at the bottom](../../assets/whats-new/root-sidebar.png)

![Root Home with the projects grid embedded as a section below the Chats list, carrying its own New Project button](../../assets/whats-new/root-home.png)

- **Instance Config and workspace Settings are two screens now, named for the
  files they write.** 0.51 stacked them: the instance-wide `paddock.config.yaml`
  form rendered as a second section *beneath* the root workspace's own settings
  form, two save bars and one page inside another — and in practice the stacking
  squashed the workspace form to zero height, so the tab had nothing it could
  scroll. They're now separate. **Config** (the sidebar gear, at `/config`) writes
  `paddock.config.yaml`, which is frozen at boot and so needs a restart to apply.
  **Settings** is a tab on each workspace, writes that workspace's `project.yaml`,
  and applies on save. The root's Settings tab is now identical to any project's.
- **Find the chats that are working right now.** The chat list's **Chats** count
  badge splits the moment a turn goes live: the total on the left, the running
  count on the right — and the right half is a button that filters the list down to
  just the chats working right now. Running chats were always findable by hunting
  down the sidebar for a spinning ring; now they're a target you can hit. The
  filtered view deliberately renders **flat**, because a running child indented
  under its running parent would put back exactly the nesting the filter exists to
  strip away, and it keeps whatever chat you currently have open pinned in so it
  can't vanish from under you the instant its turn lands. The filter composes with
  search rather than fighting it, and because it's sticky it can outlive the work
  it was filtering for — so when the last turn ends the list says "No chats are
  running." and offers you **Show all chats**.

![The Chats count badge split into a total of 8 and a highlighted running count of 4, with the list filtered to the four chats whose turns are live and rendered flat](../../assets/whats-new/running-chats-filter.png)

- **Nesting itself is now optional.** A second button beside **+** toggles the
  list between the nested tree and a flat one. Both this and the running filter are
  remembered per browser and applied everywhere, not per project — how you like to
  read a list isn't a fact about one project.

![The root workspace's tab bar leading with Home, and the chat-list toolbar where the nested-or-flat toggle sits beside the new-chat button](../../assets/whats-new/root-tab-bar.png)

- **Hold Shift to act on a whole family of chats.** The nested list could only ever
  act on one chat at a time, which made archiving a parent quietly destructive to
  the *shape* of the list: the children lost their parent from the active set and
  scattered back into the top level. **Shift-click** on archive, delete, or
  mark-read/unread now applies to a chat **and all of its descendants**,
  recursively, however deep the family goes. A plain
  click is unchanged. Deleting goes through a confirmation that counts what's
  about to go ("Manager and its 3 nested chats will be permanently removed"),
  because a collapsed parent means a shift-delete can destroy chats that aren't
  even on screen and there is no undo. The dialog also names the nested chats it
  will **keep**, since deleting a parent on its own re-homes its children to the
  top level and an irreversible action shouldn't rearrange the list without
  saying so.
- **Detach a chat from its parent.** An unlink action on any nested row promotes
  that chat to the top level with its own subtree intact — so you can archive a
  whole family *except* one chat you're still using. Nothing is destroyed;
  re-attaching is just clearing the override.
- **Real tooltips, instead of whatever your browser did.** Every native `title=`
  in the chat list is replaced by a themed tooltip that escapes the sidebar's
  scroll container and is rich enough to carry the hint that makes the subtree
  actions discoverable at all — "… · **Shift-click** to archive all 4", counting
  the chat itself along with its descendants — shown only on the rows that
  actually have any. The same hint is in each button's accessible name, so the
  affordance reaches the keyboard too.

![A nested parent row hovered to reveal its action strip, its archive button showing the tooltip 'Archive chat — file it away without deleting · Shift-click to archive all 4' above the row's three nested children](../../assets/whats-new/subtree-actions-tooltip.png)

- **No more grey browser dialogs.** The last three `window.prompt()` /
  `window.confirm()` calls — renaming a chat, reverting a chat, deleting a
  trigger — are Paddock modals now. They were unthemed browser chrome sitting one
  button away from a styled dialog, prefixed with "*⟨host⟩* says" in the installed
  PWA, and they blocked the main thread (including the live transcript) until you
  dismissed them. The revert dialog gains more than polish: its warning — that
  tool calls made after the revert point are **not** undone, only the conversation
  is — used to be glued into one undifferentiated paragraph, so the most important
  sentence in the most destructive of the three actions read like boilerplate.
  It's structured content now, with the message and tool-call counts emphasised
  and the caveat as its own callout: "**Those actions are not undone.** Files
  written, PRs opened and messages sent stay as they are — only the conversation is
  rewound." Two small behaviours were kept rather than
  lost in the move: clearing the rename field still resets a chat to its generated
  name — the modal now says so out loud ("Clear the box to reset it to the
  generated name.") and relabels its button to **Reset name**, where the old
  prompt could only be discovered by accident — and the revert
  dialog refuses to dismiss on a backdrop click, because it carries text meant to
  be read.

![The revert confirmation modal, with '6 messages' and '2 tool calls' emphasised in its summary line and the 'Those actions are not undone' warning set apart as its own callout](../../assets/whats-new/revert-modal.png)

- **Opening a project is three times faster, and the archived half costs nothing
  until you look at it.** A project's context rings had no stored counter behind
  them: every ring was derived by streaming that chat's transcript, and its
  sub-agents', end to end. The sidebar collapses the Archived group by default, so
  most of that work produced rings nobody ever saw — on one real project, 182 of
  234 chats and 349 MB of the 495 MB of transcript were archived. The rings are now
  fetched by scope, and the archived half only once you actually expand the group.
  Measured on that project: opening it went **4.18 s → 1.23 s** cold and
  **0.40 s → 0.017 s** warm.

## 0.51 — The root is a workspace

- **The root is a workspace, not a project with a magic slug.** 0.49 made the
  instance's root behave like a project by giving it a reserved `__root` slug;
  0.51 replaces that with a **workspace** model keyed by each workspace's path
  relative to your projects root. The root's key is therefore the empty string —
  the zero value already in the key space rather than a reserved name — so
  resolving it needs no special case at all. What you notice is that **the root
  always exists**: no `project.yaml` to seed, no creation endpoint, no "Enable"
  card on the grid, and no `Project not found: __root` when you click **New chat**
  on a fresh instance. Its name defaults to your projects-root directory's own
  name, and a record is only written when you actually change a setting. `/` is
  the root workspace's Home, and the projects grid is its children tab.
- **The root and a project run literally the same code.** The workspace-scoped
  routes are one Fastify plugin **mounted twice** — at `/api/root` for the empty
  key and at `/api/projects/:slug` for everything else. Same handlers, same
  schemas, same error paths, so "the root behaves exactly like a project" is true
  by construction instead of being a property someone has to remember to preserve.
  That matters because the previous design had two resolution branches to keep in
  step and one of them was missed, which 404'd every root file route in 0.49.
- **Three quiet bugs around root chats, fixed.** All three were the same
  falsy-versus-absent mistake, which an empty-string key is very good at exposing:
  a chat whose parent was a *root* chat had its recorded parent edge thrown away
  and rendered as an orphan; root chats were skipped by the recovery nudge, which
  silently disabled **Continue** and automatic re-drive for them; and root chats
  were dropped from the per-workspace unread badge.

## 0.50 — Scratch retired, and a much faster server

- **Scratch is retired — a one-off chat is a root chat now.** Scratch existed only
  because a chat had to belong to *some* agent and there was no agent for "the
  instance itself". Once the root had an ordinary keeper, scratch was redundant and
  strictly worse: it had been deliberately denied self-management tools, curation,
  triggers, attachments, run history, the `CLAUDE.md` walk-up from your projects
  root, and more than one turn at a time. A root chat gets every one of those for
  free. `/chat` is unconditionally a root chat, and the projects grid's Inbox
  section is gone.
- **Breaking: the one-off chat API is gone.** Every `/api/chats/*` endpoint went
  with the scratch agent — eleven mirrored routes, along with roughly fourteen "is
  this scratch?" branches that were the *only* reason several code paths had two of
  them. The unscoped `GET /api/commands` went too; slash commands are
  workspace-scoped now, so they live under a workspace like everything else. An
  external client using the one-off chat API moves to the root workspace's chat
  routes. **Note that 0.50's own migration advice named
  `/api/projects/__root/chats/*`, which 0.51 invalidated one release later — the
  address today is `/api/root/chats/*`, and `/api/root/commands` for commands.**
- **Promoting a chat is generalised rather than deleted.** The old "promote this
  scratch chat into a project" action was never really about scratch — it moves one
  chat from one keeper's store to another's — so it's now a generic
  workspace-to-workspace move, offered on root chats in the UI.
- **Nothing is migrated, on purpose.** Existing scratch transcripts stay exactly
  where they are on disk and simply stop being listed; the companion migration was
  dropped rather than shipped, since it meant a permanent boot-time code path
  carrying a one-time, few-hundred-kilobyte move. `PADDOCK_SCRATCH_DIR` is kept as
  a documented legacy setting so an existing config doesn't fail validation and the
  old transcripts stay findable by hand.
- **The server got dramatically faster.** Two endpoints behind the unread badge
  used to `readdir` and YAML-parse **every** job record on every `/api/projects`,
  `/api/projects/:slug` and `/chats` request. On a real instance — 1,996 records,
  46.6 MB — a CPU profile put **61% of all busy server CPU** in that one parse, and
  because it's synchronous work on a single event loop it pinned throughput at
  about 1.1 requests per second and made an unrelated 2 ms endpoint take nearly a
  second whenever a scan was in flight. Both now read through an index keyed on
  each file's mtime and size, warmed at boot so the first page load doesn't pay for
  the cold pass, and a record is only cached once it has finished — so a running
  turn can never be memoised as final. Measured on that same corpus:
  `/api/projects` **0.86 s → 0.036 s**, the projects grid's seven parallel chat
  calls **6.19 s → 0.13 s**, throughput at eight concurrent requests
  **1.06 → 18.5 req/s**, and in-browser load of a project page 2.31 s → 0.33 s. A
  companion bump to herdctl's own index-backed job listing took a project's
  **History** tab from 1.47 s to 0.15 s.
- **devbox gains Python, `uv`, `jq`, `rsync` and `kubectl`.** Python is the default
  reach for a ten-line data transform whatever the surrounding project is written
  in, and `python3: not found` turned that into "rewrite it in Node" every time;
  `jq` and `rsync` were the same gap from the other end. `uv` is there to make a
  per-project virtualenv cheap enough that libraries don't need baking into the
  image — the rule being interpreters and small CLI utilities in the image,
  libraries in the project. `kubectl` joins them because a keeper asked "is the
  deploy healthy?" needs the client present before any amount of credentials
  helps, and it can't be added downstream: it's in none of the apt sources the
  image carries. As with the Docker CLI already there, it's the **client only** —
  no kubeconfig and no cluster credentials are baked in.

## 0.49 — The root becomes a project

- **A Paddock instance can now be as capable at its root as inside any project.**
  The framing is simply that the root is the project whose directory *is* your
  projects root rather than a subdirectory of it — so its keeper is an ordinary
  keeper, with the same self-management tools, the same chat tree, the same
  per-chat model and the same sweeper. `/` is root Home and `/chat` its chats, with
  the projects grid moving to `/projects`; `/` always renders Home, with no
  redirect and no sticky last tab, so the instance's front door never lands you on
  Files.
- **Worth being blunt about the escalation this buys.** The root keeper's working
  directory *contains* every project, so root chats can read and edit any
  project's files. That's the intent — the root is where you act across the whole
  instance — but it's a real step up from a project keeper, which is confined to
  its own subtree.
- **Opt-in, and nothing changes until you opt in.** An existing instance has no
  root project until you create one from an **Enable** card on the projects grid;
  without it, `/` is the grid and `/chat` is a scratch chat exactly as before.
- **The full tab bar at the root.** History, Settings and Triggers arrive too, so
  there's no tab a project gets and the root doesn't. At the root, **Settings**
  showed the root's own workspace config above the instance-wide runtime config —
  kept as two sections rather than fused, because one is hot-applied on save and
  the other is frozen until you restart, and fusing them would hide that. (0.52
  split them into separate screens instead.) The root's overflow menu has **Edit**
  but deliberately no **Delete**: its directory *is* your projects root, so the
  action could only ever produce an error.
- **A spawned chat now records which chat created it.** The nested chat list has
  always preferred a recorded parent edge and fallen back to inferring one from
  who sent the opening prompt — but the dominant way children get made, the
  `create_chat` tool, was dropping the parent when it stamped provenance. The
  result was stark: **not one** of the 169 provenance records on the dogfood
  instance carried the field, so every edge in the live tree came from inference —
  which had already needed narrowing once after it re-parented human chats that a
  child had reported back to. New chats now record the real edge. Inference is
  unchanged and still backfills historical chats; this only stops manufacturing
  new ones that need it.
- **The file surface refuses hidden paths outright, rather than just omitting
  them.** Listing had always dropped dot-prefixed entries from what it *returned*,
  but that's presentation, not access control: naming the path explicitly still
  resolved it, and because the read route decodes an escaped slash, a nominally
  single-segment route accepted a whole nested path. Together that meant a request
  could fetch a chat transcript out of `.chats`, or a `.git/config` — which carries
  credentials when a remote embeds a token. Any dot-prefixed *segment* is now
  rejected, checked against the resolved path so `./.git` and `a/../.git` are
  caught alongside a literal one. **Honest severity: this is defense-in-depth, not
  a privilege boundary.** Paddock has no per-user role model, and anyone who can
  reach these routes can already start a keeper chat and run `Bash` — strictly more
  capability than reading a file — and the read-only `/mcp` token surface exposes
  no file verb at all, so it was never reachable there. It's worth closing because
  "hidden from the listing" shouldn't be the only thing between an API and a
  transcript. A dotfile *leaf* is still readable, deliberately: the Changes pane
  renders an untracked file's contents through this same surface, and `.gitignore`
  is untracked in a fresh repo-backed project.

## 0.48 — A trustworthy plaintext guard & a tidier chat list

- **`list_chats` hides archived chats by default, like the UI already did.** An
  agent listing a project's chats was getting the whole pile, archived ones
  included, which is not what the same list looks like on screen. Archived chats
  are now withheld unless you pass `include_archived: true`, every chat reports its
  own `archived` flag, and the result always carries an `omittedArchived` count —
  so an archived chat's session id is never *silently* unreachable.
- **The `/mcp` plaintext guard now only believes a proxy you've named.** The guard
  refuses a bearer token sent over a plaintext non-loopback connection, but it
  honoured `X-Forwarded-Proto: https` from **any** peer — so the guard could be
  switched off by the caller, including by the operator it exists to protect,
  copy-pasting a header out of a smoke-test recipe onto a real network. The
  forwarded scheme is now believed only when the immediate socket peer — which no
  client can set — is a trusted proxy. The new
  `PADDOCK_MANAGEMENT_TRUSTED_PROXIES` takes IPs, CIDRs, or the presets
  `loopback` / `linklocal` / `uniquelocal` / `none` / `all`. Its default is
  loopback plus the private address space, so every sidecar deployment keeps
  working while a **public** peer can no longer switch the guard off; name your TLS
  terminator explicitly to turn it into a real control, and the server warns once
  per peer while it's leaning on the default. This is not an authentication
  change — `/mcp` still requires a valid token, and spoofing the header never
  granted access.
- **A keeper reporting back no longer re-parents the chat it reported to.** On the
  documented report-back workflow — you start a manager, the manager spawns a
  child, the child messages home when it's done — the manager ended up adopting
  its own child *as its parent*. Both edges pointed at each other, so the tree
  builder's cycle guard picked a winner per render and the manager visibly flipped
  between sitting at the top level and sitting nested underneath its own child. A
  chat whose provenance already marks it as a root is no longer put through parent
  inference at all. Two sidebar counts are fixed alongside it: the search badge,
  which read "1/40" for a search matching five chats under one parent, and the
  Archived badge, which undercounted nested archived chats.
- **Your unread count is the same on every device now.** The same account could
  report genuinely different unread counts on different devices. Read state is
  stored per user on the server, but the client layered a *persistent* local mirror
  on top and took whichever of the two was further ahead — so a value the server
  never received marked a chat read on that device only, and the mirror never
  synced back up. The persistence is gone and the optimism stays: opening a chat
  still clears its cue instantly, but that's session-scoped, so every reload
  re-derives from the server and divergence is structurally impossible rather than
  something that had to be repaired. A failed update now rolls its optimistic bump
  back, so the cue reappears honestly instead of sticking, and a one-time migration
  pushed any read state already sitting in a browser up to the server before
  clearing it out.
- **The sweeper stops occasionally replacing a whole changelog with one sentence.**
  Post-turn curation has replaced whole files since 0.41, but the prompt registered
  with the model still described the old append-only contract — asking for "exactly
  ONE changelog bullet line" and calling `CLAUDE.md` amend-only. A model that
  weighted that over the per-sweep instructions did the obvious thing and replaced
  an entire `CHANGELOG.md` with a single sentence, which was observed in the wild
  on Paddock's own changelog. The prompt now describes what the curator actually
  does, and a test pins the contract so the two can't drift apart again silently.
- **Two image gaps closed.** The base image shipped `git` with no ssh transport, so
  every `git@` remote failed mid-turn with `cannot run ssh: No such file or
  directory` — it now installs `openssh-client`. And devbox shipped the Docker CLI
  with an empty plugin path, so `docker compose` and `docker buildx` were both
  `unknown command`; both plugins are now installed. Each was a missing runtime
  dependency of tooling the images already deliberately included.

## 0.47 — The chat list learns who spawned whom

- **Spawned chats now nest under the chat that created them.** The sidebar was
  the last place a fan-out still looked like a flat pile: a keeper that split
  work eight ways gave you eight top-level rows, in no obvious relationship to
  each other or to the chat that started it. Now a chat sits **underneath its
  parent**, indented, with a twisty to fold the whole family away and a count
  pill telling you how many chats you just folded. Everything starts expanded,
  and what you collapse is remembered per project, in that browser — folding a
  noisy fan-out on a laptop shouldn't fold it on a phone.

  The tree also changes how the list *sorts*. Siblings order by the most recent
  activity anywhere in their subtree, so a parent rises with its working
  children instead of sinking while they run, and a starred chat now floats to
  the top of **its own group** rather than the top of everything. A nested chat
  drops its violet `spawned` badge, since sitting under its parent says the same
  thing more loudly — it keeps the badge on the rare occasion it's shown at the
  top level, because its parent is archived, in another project, or filtered out
  by a search. Search pulls a match's ancestors along with it so you can see
  where a hit sits, and temporarily ignores what you'd folded.

  The edge behind all this is recorded on the chat's provenance at creation, so
  it's the same data that already drove the origin badges — now shaping the list
  rather than just decorating it. Forks record it too, nesting under the chat
  they were forked *from*. Chats you start yourself, and chats fired by a
  schedule or an event hook, stay roots: they weren't created by another chat.
  There's no migration for chats that predate this, so Paddock falls back to
  inferring the parent from who injected the chat's opening prompt — which
  recovers most existing spawned chats, though a fork made with no kickoff
  prompt left no trace to recover and stays flat.

## 0.46 — Drive Paddock from outside

- **An external MCP client can now drive Paddock.** The management operations are
  served over a streamable-HTTP MCP transport at `/mcp`, so a Claude Code session
  on your laptop — and eventually a peer Paddock — can list projects, read chats
  and, with the scope for it, start turns, all bounded by the credential it
  presents. External callers get the *same* toolset a keeper receives in-process
  rather than a parallel one, so adding a self-management tool exposes it over
  `/mcp` for free and the two surfaces can't drift. The transport is **stateless**
  — a fresh server per request, no session store, restarts transparent — and
  publishes RFC 9728 discovery metadata once you've configured an authorization
  server.
- **Management auth stands on its own, and is read-only by default.** Paddock
  authenticates `/mcp` itself, independent of `PADDOCK_AUTH_MODE` and of any
  reverse proxy, so the endpoint stays credential-gated even on an instance
  running `auth.mode: none`. Policy is enforced at the operations layer rather
  than per-transport, so every future access path inherits identical scoping
  instead of reimplementing it. Client tokens are *referenced*, never inlined —
  `auth: { ref: "env:VAR" }`, and a literal secret in the config file is a hard
  error. A client configured without an explicit scope gets read-only on purpose:
  any write scope can start keeper turns, and a keeper has `Bash`, so granting one
  is effectively remote code execution on the host. The whole thing fails closed —
  `/mcp` 404s until clients *and* a public URL are configured, and a bad
  credential gets a `401`, never a redirect to a login page no MCP client can
  follow.
- **Hover a message to see when it happened — and how full the window was.**
  Hovering any message in a transcript reveals a small rail at its top-right
  showing that message's timestamp and the context-window fill **as of that
  point**. It's a point-in-time read rather than a running total, so on a long
  chat you can finally see *where* the window actually filled up, and whether what
  you're reading is from minutes or days ago.

![The per-message hover rail on an assistant reply, showing its age, the context-window fill at that point, and the fork and revert actions](../../assets/whats-new/per-message-hover.png)

- **Fork or rewind from any point in a chat.** The same rail carries two actions.
  **Fork from here** starts a new chat containing only the transcript *up to* that
  message, leaving the original untouched — so you can try a second approach from
  the moment things diverged. **Revert to here** truncates the chat in place: it
  keeps the session id, so the URL and lineage survive, and backs the discarded
  tail up to a `.reverts/` sidecar. The confirm dialog counts the messages and
  tool calls about to disappear and says plainly what reverting does *not* undo —
  files written, PRs opened, messages sent all stay done. You're rewinding the
  conversation, not the world.
- **Mark a conversation unread.** A sixth action on each chat row toggles its read
  state, borrowing the email-client move for "I glanced at this at midnight,
  resurface it in the morning" — marking a read chat unread re-raises its accent
  dot in the list. The flag is per-user rather than shared like starring and
  archiving, since "I haven't dealt with this yet" is personal, and opening or
  focusing the chat spends it.

![A chat row hovered to reveal its six actions, with the mark-unread envelope highlighted](../../assets/whats-new/mark-unread.png)

- **An API reference, generated from the code.** Every REST route now carries a
  schema, collected into a live OpenAPI 3 document. Set `PADDOCK_OPENAPI_ENABLED`
  (**off by default**) and a Paddock-branded Swagger UI mounts at `/open-api` —
  raw spec at `/open-api.json` — reachable from a new **Swagger API** link in the
  sidebar, with an Authorize button that reflects your instance's auth mode. A
  static copy is published on this site too, as the [API reference](/api/). (The
  sidebar's "Instance settings" link became just **Settings** in this release; 0.52
  renamed it again to **Config** when instance config and workspace settings split
  into separate screens.)

![The generated Swagger UI reference mounted at /open-api, listing the System routes](../../assets/whats-new/swagger-api.png)

- **Keepers can create projects.** A new `create_project` self-management tool
  lets an agent provision a project rather than stopping to ask you to click
  **New project** — a notebook, or repo-backed by passing a git URL, which clones
  into a nested checkout and rolls back cleanly if the clone fails. It's gated
  behind its own `PADDOCK_SELF_MCP_PROJECTS` flag, **off by default**: unlike
  every other write tool it creates instance-level state and clones a URL the
  caller supplied, so it deliberately doesn't ride along on the general write
  gate.

## 0.45 — Opus 5, and a configurable model list

- **Claude Opus 5 is the default keeper model.** `claude-opus-5` heads the model
  picker — a 1M-token context window at the same per-token price as Opus 4.8, with
  markedly better verification-and-iteration behaviour for the money. New projects
  and any keeper you haven't overridden run on it now. `claude-opus-4-8` stays
  selectable for regression comparison or prompts tuned to its behaviour, and the
  sweeper keeps its cheaper Haiku default, so curation costs the same as before.
- **Choose which models your instance offers.** The picker used to show every
  model in the built-in catalog. An instance can now set an allow-list — the
  `PADDOCK_MODELS` environment variable (comma-separated ids), a `models:` list in
  `paddock.config.yaml`, or the field on the **Settings** screen — and each
  project's **Settings** tab can narrow it further, though a project may only
  *subset* what the instance offers. Leave it unset and every catalog model is
  offered, exactly as before. The catalog still owns each model's context limit
  and pricing, so an allow-list picks from it by id and can't misconfigure them.

![A project's Settings tab restricting the offered models to three of the five the instance allows](../../assets/whats-new/model-allow-list.png)

- **A queued follow-up is no longer dropped.** Type a second message while the
  keeper is still replying and it now reliably sends once the turn lands. In
  session mode a turn that produced a complete reply can still report failure in
  its trailing result frame; the queue drain — along with the post-turn curation
  sweep and the recovery watch — took that at face value and silently discarded
  the message. A real reply now supersedes a benign trailing failure, while a
  genuinely dead turn still holds its queue and keeps its error banner.
- **`releases/latest/download/…` resolves at last.** Each GitHub Release now
  carries a stable-named `paddock-latest.tgz` (and its `.sha256`) alongside the
  version-named tarball, so a self-hoster or a deploy recipe can fetch the newest
  build from a fixed URL — GitHub's `latest/download` redirect only works when the
  filename is identical across every release. Pin `paddock-<version>.tgz` instead
  when you'd rather not float.

## 0.44 — Two official images & ready-made deploy recipes

- **Two published images.** The Docker build now ships as **two** tags from the
  same source: `ghcr.io/edspencer/paddock:latest` — the lean **base** image (app +
  `git`, `gh`, the `claude` CLI) — and `ghcr.io/edspencer/paddock:devbox`, which
  layers the coding-agent toolbox on top (`pm`/PM2 preview servers, `ffmpeg`, a
  headless Playwright browser, the Docker CLI). Same app and `/data` layout, so you
  can swap tags against one volume. See [Getting started](/getting-started/#two-image-flavors-base-vs-devbox)
  and [The Dev Box flavor](/guides/dev-box-flavor/).
- **A recipes repo.** Self-hosting recipes now live in their own public repo,
  [**`paddock-deploy`**](https://github.com/edspencer/paddock-deploy):
  [`docker/`](https://github.com/edspencer/paddock-deploy/tree/main/docker)
  (base + devbox compose), `proxmox-iac/` (Tofu + Ansible for a dev box or home
  box), `kubernetes/` (Kustomize manifests), and `auth-basic/` (a Caddy Basic Auth
  sidecar → `trusted-header`). The [Deploying](/guides/deploying/),
  [Proxmox (LXC)](/guides/proxmox-lxc/), [Kubernetes](/guides/kubernetes/), and
  [Securing](/guides/securing/) guides each point at the matching recipe.
- **Safe-by-default binding.** A fresh source/tarball run now binds `127.0.0.1`
  (loopback only) and refuses to expose itself without either a real auth mode or
  an explicit `PADDOCK_DANGEROUSLY_ALLOW_OPEN` opt-in. Container images still bind
  `0.0.0.0` (the network namespace is their boundary); the recipes carry the
  host-side publish posture.
- **Live nested sub-agent cards.** When a keeper spawns sub-agents — even several
  levels deep — each one now renders as its own live card that fills in as it
  runs: a running spinner, streaming progress, and a cost that rolls its
  descendants' costs up into the parent. Nested unattended work is legible while
  it happens, not just after a refresh.

## 0.43 — Background work that outlives the turn

- **Background tasks survive the turn boundary.** In session mode, work a keeper
  kicks off in the background — a `run_in_background` sub-agent or shell, a build,
  a deploy, a scheduled wake-up — now keeps running when the turn that started it
  ends, and **delivers its result live** the moment it finishes, waking the keeper
  to continue or report back. No reload, and no more work lost to Paddock's own
  turn teardown. This is what makes "kick off something slow, get pinged when it's
  done" reliable for keepers. A task can still be killed from further upstream —
  that case is unchanged, and it's what
  [keeper-chat recovery](/configuration/keeper-recovery/) is for.

## 0.42 — Instance settings, curation budgets & pinned files

- **An instance-wide Settings screen.** A new top-level **Instance settings**
  screen (the gear in the sidebar) edits your `paddock.config.yaml` straight from
  the UI — grouped fields for curation, capability gates, auth, attachments and
  more. Instance config is read once at boot and frozen, so a save writes the file
  and shows a **restart-to-apply** banner; a field already pinned by an environment
  variable renders read-only with an "overridden by `ENV`" note, so the precedence
  is never a surprise. (This screen is **Config**, at `/config`, as of 0.52 —
  "Settings" now means a *workspace's* own `project.yaml`.)

![The instance-wide Settings screen, editing paddock.config.yaml from the UI with a restart-to-apply banner](../../assets/whats-new/instance-settings.png)

- **Per-project curation budgets.** Each project's **Settings** tab can now cap the
  post-turn sweeper's per-file token budgets — how big it lets `OVERVIEW.md`,
  `CHANGELOG.md` and `CLAUDE.md` grow — or leave a field blank to inherit the
  instance default. Lower a budget to shrink the context a chatty project injects
  into every one of its chats.

![Per-project curation budgets in the Settings tab, overriding two files and inheriting the third](../../assets/whats-new/curation-budgets.png)

- **Pin any file as a tab — at any depth.** The Files browser's pin now works on a
  file **anywhere** in the tree, including nested ones; a pinned file rides along
  as a persistent tab in the project header next to Home / Chat / Files, one click
  from whatever you keep coming back to.

![Pinned files riding along as tabs in the project header, at any depth](../../assets/whats-new/pinned-file-tabs.png)

## 0.41 — Pinned chats, resizable panes & a smarter sweeper

- **Star a chat to pin it.** Star any chat and it floats to the top of its list —
  a lightweight way to keep the conversation you're living in (or the run you're
  waiting on) one click away. Starring is purely presentational and independent of
  archiving: starred chats float to the top of both the active and the archived
  sections.

![The chat list with two starred chats pinned to the top](../../assets/whats-new/starred-chats.png)

- **Draggable, persisted pane widths.** Grab the divider to resize the side-nav and
  the chat-list column to taste; your widths are remembered in the browser across
  reloads, so the layout you like stays put.
- **A one-row mobile header.** On a phone the project header collapses to a single
  row and the composer typography was tidied up, so the small-screen layout stops
  fighting for vertical space.
- **The sweeper is a full-file curator.** Post-turn curation now **rewrites** the
  whole `OVERVIEW.md` / `CHANGELOG.md` to stay within a token budget, instead of
  only ever appending — so those files stay tight and readable rather than growing
  without bound. (0.42's per-project budgets tune exactly these limits.)

## 0.40 — Promote a notebook to a repo, dictate while it types

- **Promote a notebook project to repo-backed, in place.** A notes-only project can
  now be turned into a full code project without recreating it: point it at a git
  repo and Paddock clones it as the keeper's working directory — the repo's own
  `CLAUDE.md`, branches and PR flow take over from there — keeping the project's
  history and chats.
- **Dictate while the keeper is replying.** The composer's microphone stays usable
  **during** a streaming reply, so you can start dictating your next message while
  the agent is still writing its last one — no waiting for the turn to land.

## 0.39 — Dead-end turns, made legible

- **Turn errors and usage-limit hits surface in the UI.** A keeper turn can stop
  *without* a normal reply — a subscription/usage-limit hit, the max-turns cap, or
  an outright error. These used to leave a chat looking mysteriously dead. Each now
  shows a distinct inline notice: a usage-limit note with the reset time, a
  turn-limit note with a **Continue** button, or an error with **Retry**.

![An inline 'Session limit reached' notice showing when the quota resets](../../assets/whats-new/turn-notice.png)

- **Run-now + live status for triggers.** The **Triggers** tab regained a
  **Run now** action to fire any schedule or event on demand, plus live run-status
  and Last/Next-run columns — so you can test a trigger and watch it go without
  waiting for its clock.
- **Spawned chats can pick their model.** The `create_chat` / fork self-management
  tools can now set the model of the chat they spawn, so a manager keeper can send
  cheap work to a smaller model and hard work to a bigger one.
- **Client-local slash commands render.** `/context` and `/usage` now show their
  formatted output inline instead of an empty (or raw-XML) bubble.

## 0.38 — Send files & images to a keeper

- **Attachments in the composer.** Attach files and images to a message —
  **pick** them with the paperclip, **drag & drop** onto the composer, or **paste**
  (⌘V / Ctrl+V) a screenshot straight in. Staged files sit in a removable tray;
  images preview as thumbnails, everything else as a chip. The keeper reads them
  directly — **native vision** on images and PDFs, plain-text reads on the rest —
  and sent files stay with the chat, re-rendering on reload. Per-instance and
  per-project caps (default 25 MB/file, 10 files/message, all types) keep it sane.
  See [Sending files & images](/using/sending-files-and-images/).

![The composer attachment tray with an image and a file staged to send](../../assets/using/attachment-tray.png)

## 0.37 — Triggers, unified

- **One Triggers tab.** The per-project **Hooks** tab and the **Settings →
  Schedules** section merged into a single **Triggers** list. Every trigger type —
  schedule, event, and the reserved webhook — lives in one place, each row showing
  its type, its firing condition, a capability summary, and an enabled toggle.
- **One self-management surface.** The old `set_hook` / `set_schedule` tool
  families are replaced by unified **`set_trigger` / `list_triggers` /
  `remove_trigger`**, carrying the trigger *type*, its *run*, and *enabled* — so a
  keeper declares any kind of trigger the same way.
- **Schedules can be scoped.** A schedule that declares a tool allow-list now runs
  on its **own scoped agent** with just those tools (like an event trigger); a
  schedule with no tools keeps running as the keeper, as before.
- **The sweeper is a trigger.** Post-turn curation is now the implicit default
  **`curate-overview`** trigger — declare one to give a project a bigger model or
  extra instructions, or disable it entirely. Undeclared projects curate exactly as
  before. See [The sweeper](/concepts/sweeper/#customise-or-disable-it).

:::note[Webhook triggers are reserved]
The **`webhook`** trigger type is shape-reserved — it appears in the model and the
Triggers form but is **not yet fireable** (there's no inbound webhook ingress yet).
:::

## 0.36 — Streaming, and session mode by default

- **Token-by-token streaming.** In session mode a keeper's reply now accretes into
  the live bubble **as it's written**, instead of appearing all at once when the
  turn finishes. (Batch mode still renders each message whole.) See
  [Token-by-token streaming](/concepts/chats/#token-by-token-streaming).
- **Session mode is the default.** A fresh instance now drives keeper turns through
  the persistent session (SDK) runtime by default, so cross-turn autonomy
  (`ScheduleWakeup`, `/loop`) and streaming work out of the box.
  `PADDOCK_KEEPER_DRIVE_MODE=batch` (and the per-project `driveMode`) still switch
  back to the one-shot path.
- **The trigger foundation.** Under the hood, hooks and schedules were unified onto
  one discriminated **trigger** model (`schedule` / `event` / `webhook`) over a
  single execution core — the groundwork the 0.37 Triggers tab is built on.

## 0.35 — Keepers that unstick themselves

- **Keeper-chat recovery.** When a keeper starts a background task and ends its turn
  while it's still running, the task can be killed at the turn boundary and leave
  the keeper idle-but-alive. Paddock now surfaces that as a distinct amber
  *"background task terminated — the keeper is idle"* affordance with a one-click
  **Continue** that wakes the keeper to finish or report. An optional
  **automatic** re-drive (off by default) does the same without you. See
  [Keeper-chat recovery](/configuration/keeper-recovery/).

## 0.34 — Event hooks

- **Event hooks.** Run an agent turn automatically when a lifecycle event fires.
  The first event is **`onArchive`** — when a chat is archived, each of the
  project's enabled hooks fires as its own agent. A hook's granted tools *are* its
  capability: a hook that must tidy up is given `Bash` and does the work itself.
  New hooks start **disabled**, so nothing runs until you arm it.
- **Hook chats are visible and legible.** A hook run shows up in the chat list
  with a small lightning-bolt badge, and opening it floats a read-only banner
  telling you it's a hook agent, what event triggered it, and exactly which tools
  it was granted.
- **Manage hooks from a chat.** Keepers with the opt-in hook MCP can declare,
  edit, and remove their own hooks (`list_hooks` / `set_hook` / `remove_hook`).
- **Steer the sweeper per project.** Drop a `.paddock/hooks/sweep.md` file in a
  project and its contents are appended to the sweeper's instructions — so each
  project can shape how its `OVERVIEW.md` / `CHANGELOG.md` get curated.

## 0.33 — Who sent this, and a lighter stream

- **Per-message attribution.** Machine-injected turns now say who added them —
  "↩ sent by *⟨chat⟩*" for a `send_message` from another chat, or "⏰ scheduled by
  *⟨name⟩*" for a schedule fire. Human-typed messages stay unlabelled. An injected
  message also streams into an already-open chat immediately, no refresh needed.
- **Schedule yourself from a chat.** New self-management tools let a keeper create
  and manage its project's durable schedules (`set_schedule` / `remove_schedule` /
  `list_schedules`) — "schedule yourself to triage issues every morning" — not
  just a human clicking through Settings.
- **Cheaper streaming.** The CPU cost of watching a chat stream dropped sharply:
  the continuous 60fps animations were trimmed, respect `prefers-reduced-motion`,
  and pause while the tab is in the background.

## 0.32 — Schedules & run history

- **Scheduled chats.** A project can declare **schedules** (cron or interval) that
  start a chat on their own. A scheduled run is a first-class chat — it streams
  live, is re-attachable, and a human can open it and keep the conversation going.
  Manage them from a **Schedules** section in the project's Settings, including
  enable/disable and **trigger-now**.
- **"While you were away."** A new project **History** tab lists recent runs with
  their origin (human / scheduled / spawned), flags the ones that are new since you
  last looked, and banners how many ran unattended — so cron-fired and agent-spawned
  work is easy to find and open.

![A project's Settings tab, where per-project keeper behaviour and schedules are configured](../../assets/whats-new/settings.png)

## 0.31 — Provenance, spawn-depth & YAML config

- **Provenance badges.** The chat list marks **scheduled** and **spawned** chats
  with a subtle icon, so the runs that happened without you stand out from the ones
  you started. Human chats stay unadorned.
- **Spawned children can report back.** A chat spawned by another chat now gets the
  self-management tools (bounded by a new **`maxSpawnDepth`**, default `1`), so a
  child can `send_message` its parent when it's done — enabling the manager-agent
  pattern without runaway recursion.
- **Configure an instance from a YAML file.** Instead of a long list of `PADDOCK_*`
  environment variables, an instance can keep its settings in a single
  [`paddock.config.yaml`](/configuration/config-file/) — with environment variables
  still overriding the file. Env-only deployments are unaffected.

## 0.30 — Files, Changes & self-archiving

- **Browse into subdirectories.** The Files tab now lets you click into folders,
  with deep-linkable, refresh-safe URLs and a breadcrumb — so anything a project
  filed under `design/`, `docs/`, etc. is finally reachable.
- **Selective commits.** The Changes tab gained a checkbox per changed file (with
  select-all/none) and a "Commit N selected" action, a `+A −R` line stat per file,
  and a dirty-file count on the projects grid so pending work is visible before you
  open a project.
- **Agents can archive themselves.** New `archive_chat` / `unarchive_chat`
  self-management tools power the "do the work, then archive myself on success;
  leave un-archived on failure so a human sees it" convention.

![Browsing into a project subdirectory in the Files tab](../../assets/whats-new/files.png)

## 0.29 — First-class MCP tool rendering

- **Paddock's own tools render as first-class UI.** Every `mcp__…` tool call now
  shows a humanized name (`mcp__paddock_manage__create_chat` → "Create chat") with
  a brand badge instead of the raw string, and the `paddock_manage` tools get rich
  bodies parsed from their output — project chips, a chat list with live running
  dots, transcript previews — that link straight into the chats they touched.

![A chat showing Paddock's own MCP tools rendered as first-class UI elements](../../assets/whats-new/chat-tools.png)

---

*Maintaining this page:* add a short, user-facing entry here whenever you cut a
release (see [RELEASING.md](https://github.com/edspencer/paddock/blob/main/RELEASING.md)).
