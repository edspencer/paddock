---
title: Reading a keeper's work
description: How to review what a keeper actually did — richly rendered tool calls (diffs with line numbers, images, exit codes, search counts, background jobs), live nested sub-agent cards, Paddock's own tools as first-class UI, the context + cost meter, pinned file tabs, and the Files and Changes tabs for browsing and committing what the agent produced.
---

A keeper doesn't just reply — it *works*: it reads files, edits them, runs
commands, searches the tree, spawns sub-agents, and launches background jobs. A
plain chat log would flatten all of that into walls of text. Paddock instead
renders each of the keeper's tool calls as a compact, expandable block, and gives
you two dedicated tabs — **Files** and **Changes** — for inspecting and
committing what the agent left behind.

This guide is a tour of those review surfaces. For *who* did a piece of work (a
human, a schedule, another chat), see the companion
[Provenance concept](/concepts/provenance/).

## How tool calls render

Every tool the keeper calls becomes a collapsible block in the transcript. The
header always shows a per-tool icon, the tool name, a short subtitle (usually the
target), and — on the right — a duration and any status chips. Click a block to
expand its body. Blocks that carry a rich body (a diff, an image, split output)
have that detail reconstructed from the transcript when the chat loads, so
reading a conversation back shows the full rich rendering. (A tool call whose
transcript carries no such detail simply falls back to its plain output.)

![An expanded Edit tool block showing a git-style diff with real file line numbers and red/green +/− lines, above an expanded Bash block showing its command output](../../../assets/using/reading-tool-block-diff.png)

### Edit and Write show a real diff

An `Edit`, `MultiEdit`, or `Write` renders as a **git-style diff with real file
line numbers** — not a guess. Paddock reads the structured patch Claude Code
already computed, so each hunk carries its true `@@ -old,n +new,n @@` header, a
left gutter of old line numbers, a right gutter of new ones, and red/green tinting
for removed and added lines. The header carries a compact `+3 −2` stat (additions
in green, deletions in red). Very large diffs are capped for rendering — the stat
stays exact and a note flags that the diff was truncated.

### Read shows the range — and inlines images

A `Read` block's subtitle is the file, and its metadata shows the line range that
was read, e.g. **`lines 40–71 of 210`**. When the keeper reads an **image** that
lives inside the project directory, the block renders the picture **inline**
rather than a path — so a screenshot the agent looked at is right there in the
transcript.

### Bash separates stderr and surfaces the exit status

A `Bash` block shows the command as its subtitle. When there's more to say than a
clean stdout, the body **splits stderr into its own red panel** so warnings and
errors don't hide inside normal output. The header can carry an interpretation of
the exit status (for example *Exited with code 0*), an amber **interrupted** chip
if the command was cut off, and a short hint for a recognised git operation (like
`push → main`). A clean command with nothing unusual just shows its output.

### Grep and Glob show counts

A search collapses to its result size instead of dumping every hit: a `Grep`
shows something like **`11 lines · 3 files`** (or just the file count in
files-with-matches mode), and a `Glob` shows **`N matches`**. A truncated result
set is prefixed with `≥` so you know the real number is larger than shown.

### Sub-agents and background jobs stand out

- A `Task` (or SDK `Agent`) call — a **sub-agent** — is tinted with an accent
  border and a **sub-agent** badge, with a spark icon and the sub-agent's
  description as its subtitle. Its own steps and its token cost roll up into the
  block, and you can expand it to load the nested steps the sub-agent ran.
- Anything launched detached — a `Monitor`, a background-task op like
  `BashOutput` / `TaskStop` / `KillShell`, or a `run_in_background` command — gets
  a sky-blue **background** badge and a colored status chip (`running`,
  `completed`, `killed`, `timed out`) so long-lived async work is easy to spot and
  track.

### Sub-agent cards fill in live

You don't have to wait for a reload to see what a sub-agent is doing. The card is
**enriched the instant the sub-agent launches**: its real type (e.g.
`general-purpose`) and description are recovered from the tool call as it streams,
and a still-working sub-agent shows a **running** spinner where its duration will
land. **Expand a running sub-agent** and its nested steps appear as they happen,
refreshed every couple of seconds from the sub-agent's own growing transcript —
and those nested steps recurse, so a sub-agent that spawned its own sub-agents is
expandable all the way down.

Two things to know about the numbers on a sub-agent card:

- **Cost is the recursive total** — the sub-agent *plus* everything it spawned,
  however deep. That's what you want when you're asking "what did delegating this
  actually cost."
- **Durations stay per-agent.** Nested sub-agents run in parallel, so summing
  their durations would badly overstate the elapsed time; each card reports only
  its own run.

:::note[What fills in later]
A running sub-agent's **duration and cost** appear once it settles (or on
reload) — they aren't estimated mid-flight. And while a *deeper* sub-agent (one
spawned by another sub-agent) is still running it shows as a generic row; it
picks up its real type, steps, duration and cost within a poll of finishing.
:::

### Background work outlives the turn

Since **v0.43**, work a keeper kicks off in the background on a session-mode chat
— a `run_in_background` shell, a background sub-agent, a long build — keeps
running when the turn that started it ends, including on a brand-new chat's very
first turn. When it finishes, the keeper's follow-up turn **streams into the open
chat live**, with no refresh. So a card that says `running` when the turn ends is
genuinely still working, and you'll see the result land in place.

:::caution[Not every background death is fixed]
A separate, upstream failure mode still exists — the underlying Claude Code
runtime can kill a still-running background child a couple of seconds after a turn
ends, leaving the keeper idle with nothing to wake it. That's what
[keeper-chat recovery](/configuration/keeper-recovery/) surfaces and re-drives,
and it's still shipping and still relevant.
:::

### Errors and in-flight calls

A tool that failed is tinted rose with an **error** chip; a tool still running
shows a spinner and a **running** label, which reconciles into the finished block
the moment its result lands.

## Paddock's own tools render as first-class UI

When a keeper uses Paddock's *own* management tools — the `mcp__…` tools it can be
given to create chats, fork them, send messages between them, or list projects —
those don't render as raw `mcp__paddock_manage__create_chat` noise. Each gets a
**humanized name** (so `create_chat` reads as **Create chat**), a **Paddock**
badge, and a per-tool icon.

The management tools also get **dedicated bodies** parsed from their result: a
list-projects call shows project pills; a list-chats call shows a chat list with
live running dots; a create or fork call shows the chat's real title and its
kickoff prompt, and a send-message call shows the message — each with a **link
straight into the chat it touched**.

![A 'Create chat' tool block rendered with a Paddock badge, showing 'Created chat Draft the API reference in lumen-cli', an 'open chat' link, and the kickoff prompt](../../../assets/using/reading-mcp-create-chat.png)

:::note[These tools are opt-in]
The self-management tools are only present when the operator has enabled them for
an instance (and, for spawned chats, within a bounded depth). Most keepers won't
have them — but when they do, this is how their fan-out work reads back. See
[Provenance](/concepts/provenance/) for how the *chats* they create are labelled.
:::

## The live context + cost meter

While you read, two small readouts tell you how "heavy" the chat has become. They
live in the sidebar (a **context ring** per chat) and in the composer's status row
(a fuller **context + cost** line):

- **Context** is how full the model's context window is — the tokens from the
  **last completed turn** as a percentage of that model's limit (1M for Opus,
  Fable, and Sonnet; 200K for Haiku), shown like `120k / 1000k (12%)`. Because it
  reflects the last *completed* turn, it updates a beat behind a streaming turn,
  and the ring/bar turns **amber** as you near the top of the window. Before a
  chat's first turn there's nothing to measure, so it reads `context: —`.
- **Cost** is the chat's cumulative token usage and an estimated dollar figure,
  **including tokens spent by any sub-agents** the keeper spawned. The dollar
  number is a **ballpark at standard API list prices** — a sense of scale, not a
  bill; on a Claude subscription it won't match what you're actually charged.

The two are different *kinds* of number, which is worth internalising: **context
is a snapshot, cost is a running total.** Context answers "how full is the window
right now"; cost answers "what has this whole chat consumed so far".

:::note[The meter used to overshoot after tool-heavy turns]
Up to **v0.42.1** the live meter could jump far above the real figure right after
a long, multi-step turn — reading something like `828k / 1000k (83%)` when the
window actually held ~292k — and a refresh would correct it. It was folding the
turn's *cumulative* usage (aggregated across every internal round-trip) into what
should have been a single point-in-time snapshot. Fixed in **v0.42.2**: the live
meter now matches what you'd get on reload, so a tool-heavy turn no longer
inflates it.
:::

To see how the window filled up *over the course of* a chat rather than just where
it stands now, hover any message — the
[per-message rail](/using/working-in-chats/#hover-a-message-time-context-fork-and-rewind)
shows the context fill as of that point.

## Browse what the agent wrote: the Files tab

The **Files** tab lists the project's working directory, one level at a time. Sub-
directories the keeper filed things under — a `docs/`, `design/`, or `src/` — are
first-class: folders are visually distinguished, sort ahead of files, and carry a
chevron. Click a folder to descend; a `..` entry and a path breadcrumb take you
back up.

![The Files tab at a project root, showing design, docs and src folders with folder icons sorted above CHANGELOG.md, CLAUDE.md, project.yaml and README.md](../../../assets/using/reading-files-subdirs.png)

The current folder or file is carried in the URL as
`/projects/<slug>/files/<path>`, so a view **deep into a subtree is
deep-linkable** and survives a refresh — handy for pointing someone at exactly
the file you're looking at. Clicking a file opens it inline.

### Pin a file as a tab — at any depth

Any file you can reach through the Files browser can be **pinned as a tab**, from
either its list row or its viewer. A pinned file then rides along in the project
header next to **Home / Chat / Files**, one click from whatever you keep coming
back to.

![Pinned files riding along as tabs in the project header, at any depth](../../../assets/whats-new/pinned-file-tabs.png)

Pinning used to be restricted to files at the **project root**; since **v0.42**
that gate is gone, so a `design/plan.md` or `src/lib/auth.ts` pins just as well.
A nested tab shows just the **basename** to stay compact — hover it for the full
project-relative path.

## Review and commit: the Changes tab

For a project whose store is a git repo, the **Changes** tab is where you turn a
keeper's edits into commits. It lists every uncommitted file with its status
(added / modified / deleted / renamed / untracked) and a per-file **`+A −B`** line
stat; selecting a file shows its diff, with a matching stat in the diff header.
Untracked files show their new content rather than an empty diff.

The commit is **selective**. Each file has a checkbox (with a select-**All** /
**None** toggle and a running `N/M selected` count), so you can commit a subset
rather than everything at once. The commit button reflects the selection: it reads
**Commit** when everything is selected and **Commit N selected** when you've
narrowed it down.

![The Changes tab with three changed files, one checkbox unticked so 2 of 3 are selected, per-file +/− stats, a README diff, and a 'Commit 2 selected' button](../../../assets/using/reading-changes-selective-commit.png)

You don't have to open a project to notice it has pending work: the **projects
grid flags each project's uncommitted-file count** with a small amber pill (a
branch icon and the count), fed by a single cheap `git status` over the whole
store — so a checkpoint that's waiting to be made is visible before you even
click in.

## Branch or rewind from what you just read

Reviewing often turns into "let me try a variation from here." Forking a chat
copies its full history into a new, independently resumable chat (see
[Chats are sessions](/concepts/chats/#forking)). Paddock lets you **name the fork
up front**: the Fork dialog opens with a **Fork name** field pre-filled with
*"Fork of ⟨chat⟩"*, selected so a keystroke replaces it — so the branch lands in
your sidebar with a meaningful title instead of an auto-summary you have to rename
later.

You can also branch from a **specific point** rather than the whole chat. Hovering
any message reveals **Fork a new chat from here** (which copies only the
transcript up to that message) and **Revert conversation back to here** (which
truncates this chat in place, backing the discarded tail up). That's the move when
a review tells you the keeper went wrong at an identifiable step — rewind to just
before it, or branch and try the other approach. See
[the per-message rail](/using/working-in-chats/#hover-a-message-time-context-fork-and-rewind)
for the details, including the important caveat that reverting rewinds the
*conversation*, not the files, PRs or messages the keeper already produced.

## Next steps

- [Provenance: who did what](/concepts/provenance/) — the origin and per-message
  attribution behind the chats you're reading.
- [Working in chats](/using/working-in-chats/) — the composer, queue, Stop,
  unread dots, and the context + cost meter in day-to-day use.
- [Chats are sessions](/concepts/chats/) — persistence, resume, and forking.
- [The sweeper](/concepts/sweeper/) — the post-turn curation that keeps a
  project's `OVERVIEW.md` and `CHANGELOG.md` current.
