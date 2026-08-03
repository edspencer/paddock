---
title: "The sweeper"
description: "The post-turn, tool-less agent that curates each project's OVERVIEW, CHANGELOG and CLAUDE.md — a full-file curator working to a per-file token budget."
---

The **sweeper** keeps a project's notes current without you having to. After each
of your chat turns in a project, a per-project, **tool-less** curation agent reads
what just happened and updates three files: `OVERVIEW.md` (the current state),
`CHANGELOG.md` (the running history), and the curated-notes section of
`CLAUDE.md`. It runs quietly, out of band — you never chat with it.

:::note[The sweeper is now a trigger]
Since **v0.37** the sweeper is the project's **implicit default `curate-overview`
trigger** — an [`afterTurn` event trigger](/concepts/schedules/#what-a-schedule-is).
Nothing to configure: a project that declares no such trigger curates exactly as
described here. Declaring one only *customises* the default (a different model, an
extra prompt) or turns it **off** — see [Customise or disable it](#customise-or-disable-it).
:::

## What it is

- **Per project.** Each project has its own `sweeper-<slug>` agent, whose working
  directory is a **dedicated scratch dir outside the projects tree**
  (`<dataDir>/sweepers/<slug>`). Agents bind to a cwd, so the sweeper can't share
  one across projects — and since [#548](https://github.com/edspencer/paddock/issues/548)
  it deliberately does not sit in the project directory, where it would collide
  with the project's own agent.
- **Tool-less.** The sweeper is configured with `allowed_tools: []` and a small
  model (`SWEEPER_DEFAULT_MODEL`, Haiku by default, `max_turns: 4`), gets **no
  injected MCP tools** (unlike every other turn path, it does not even receive
  `send_file`), and is told in its system prompt: *"You DO NOT use any tools — you
  only return text."* It only *returns text*; Paddock's `SweepService`
  (`sweep.ts`) parses that text and writes the files. So a curation pass never
  mutates your code and can never trigger another sweep — the write side is
  Paddock's, not the agent's.

  :::note[Where that guarantee comes from]
  Mostly from the prompt, the missing tools and the four-turn bound rather than
  from the empty list itself: both runtimes emit `--allowedTools` only when the
  list is **non-empty**, so `allowed_tools: []` passes *no* allow-list rather than
  an empty one ([#647](https://github.com/edspencer/paddock/issues/647)). The
  sweeper is still the narrowest agent Paddock runs, but if you
  are reasoning about a scoped **trigger**, see
  [What your agents can do](/guides/agent-capabilities/#scoped-agents-triggers-and-hooks).
  :::

## When it runs

1. Every completed turn — a human chat turn, a session-mode
   wake, or a server-initiated agent turn — emits **one** `afterTurn` lifecycle
   event, and its sole consumer enqueues the curation sweep. So the sweeper
   dispatches **exactly once per turn** (no double-curation), whatever drove it.
2. Sweeps are **debounced/coalesced**: at most one per project per
   `minIntervalMs` (default **5 minutes**, `PADDOCK_SWEEP_MIN_INTERVAL_MS`).
   Bursts of turns fold into a single trailing run.
3. An **activity gate** skips no-op sweeps: `SweepService` tracks the newest chat
   session mtime it last swept in `sweep-state.json`, and does nothing if there's
   been no new activity since. On failure, it retries the same activity next time
   rather than advancing past it.

Because it's an `afterTurn` trigger with an `enabled` flag, a project can also
turn curation **off** — see below.

## What it produces

The sweeper is prompted with a **digest** of recent activity — the last ~40
messages of every chat that's been touched since the last sweep, capped at **6**
chats so a burst of concurrent conversations can't unbound the prompt — plus each
of the three curated files.

Since **v0.41** the sweeper is a **full-file curator**, not an appender. It is
shown each curated file **in full** and must return either that file's *complete
new contents* or the literal `NOCHANGE`. It replies with marked sections as plain
text:

```
<<<OVERVIEW>>>
…the FULL new OVERVIEW.md, or NOCHANGE…
<<<CHANGELOG>>>
…the FULL new CHANGELOG.md, or NOCHANGE…
<<<CLAUDE>>>
…the FULL new "## Curated notes" body, or NOCHANGE…
<<<END>>>
```

`SweepService` parses the markers and writes the files itself. A `NOCHANGE` (or
empty) section leaves that file untouched:

- **`OVERVIEW.md`** — replaced **wholesale**. It's a synthesized "what this
  project is, key decisions, open questions, next steps" written for an LLM to
  read at the start of a new chat (and offered as the optional preload context on
  a new chat).
- **`CHANGELOG.md`** — also replaced wholesale. The sweeper adds at most **one**
  bullet under a `## YYYY-MM-DD` heading at the top (newest-first), reusing
  today's heading if it's already there, **coalesces** near-duplicate recent
  bullets, and drops or summarizes the oldest entries to stay inside the file's
  budget. A change-detection gate means an uneventful turn returns `NOCHANGE`
  rather than re-logging unchanged state. Paddock itself only stamps the
  `# Changelog — <slug>` title.
- **`CLAUDE.md`** — the body under the `## Curated notes` heading is replaced
  with a de-duplicated, pruned version; everything above that heading is
  preserved verbatim. Never curated for a repo-backed project (whose `CLAUDE.md`
  is upstream-owned).

If the markers are missing or unparseable, the sweep throws — the activity
watermark doesn't advance and no partial/garbage content is written. Every sweep
failure is non-fatal to your chat.

:::tip[Why full-file, not append]
The old sweeper saw only the first couple of thousand characters of each file and
blind-appended to it — so it re-added things it had already written, and
`CHANGELOG.md` (and the curated `CLAUDE.md` notes, and therefore the context every
chat in the project preloads) grew without bound. Showing the curator the whole
file is what lets it *rewrite* rather than only accrete.
:::

## Per-file token budgets

Each curated file has a **token budget** the sweeper is told to keep it under, and
which Paddock enforces as a backstop at write time:

| File | Instance setting | Environment variable | Default |
| --- | --- | --- | --- |
| `OVERVIEW.md` | `curation.overviewMaxTokens` | `PADDOCK_CURATION_OVERVIEW_MAX_TOKENS` | `2000` |
| `CHANGELOG.md` | `curation.changelogMaxTokens` | `PADDOCK_CURATION_CHANGELOG_MAX_TOKENS` | `8000` |
| `CLAUDE.md` | `curation.claudeMaxTokens` | `PADDOCK_CURATION_CLAUDEMD_MAX_TOKENS` | `6000` |

Precedence is the usual **built-in default → `paddock.config.yaml` → environment
variable**, and since **v0.42** any project can override any subset of the three
in its `project.yaml` (or from its **Settings** tab):

```yaml
# project.yaml — override two, inherit the third
curation:
  overviewMaxTokens: 800
  changelogMaxTokens: 2400
```

Resolution is **field by field** at sweep time: a field you don't set tracks the
instance default as you change it, and an invalid value degrades to "inherit"
rather than failing the sweep. Lowering a budget shrinks the context a chatty
project injects into every one of its chats. See
[Creating & organizing projects](/using/creating-and-organizing-projects/#curation-budgets)
for the Settings-tab view.

When a file is already larger than its budget, the sweeper is shown a **bounded
view** that keeps the **top** of the file and truncates the older tail, with an
explicit marker telling it to preserve what it can't see. Because `CHANGELOG.md`
is newest-first, that means the curator always sees the most recent history.

## Customise or disable it

The sweeper is the default **`curate-overview`** trigger, so you shape it the same
way you shape any trigger — by declaring one in the project's `project.yaml` (or
from a chat with the trigger-management tools). A project that declares nothing
behaves exactly as above; a declared `curate-overview` trigger only
*customises* the default via its `run`:

- **A different model.** `run.model` overrides the sweeper's model for this
  project — e.g. a larger model for a project whose notes need more synthesis.
- **Extra instructions.** `run.prompt` / `run.promptFile` are appended to the
  curator prompt under an `=== EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS ===`
  heading (the same slot as a project's `.paddock/hooks/sweep.md` file) — so you
  can tell the sweeper what this project cares about without touching Paddock.
- **Off.** Set the trigger `enabled: false` to switch curation off for a project
  entirely: no sweep runs, and `OVERVIEW.md` / `CHANGELOG.md` are left to you.

Unlike every *other* event trigger, the curator is **not** run as its own
`trigger-<slug>-<name>` agent and is **not** fanned out to the generic event
dispatcher — it's tool-less by nature (it returns marked text; Paddock writes the
files), so it keeps running through `SweepService` on the `sweeper-<slug>` agent.
Its `run` block therefore only tunes the sweep (model, prompt, `enabled`); trigger
fields that imply a scoped agent (a tool allow-list, a permission mode) don't
apply to it.

:::note[`afterTurn` is reserved for curation]
The `afterTurn` event currently drives **only** the built-in curator. It isn't a
general "run anything after every turn" hook — a `curate-overview` trigger tunes
the sweep, it doesn't spawn an arbitrary agent per turn.
:::

## Why it's designed this way

Splitting "decide what to write" (the agent, text-only) from "write the files"
(Paddock, deterministic) means the curation model is cheap, sandboxed, and
idempotent, and the file layout stays under Paddock's control. It's the mechanism
that keeps `OVERVIEW.md` a reliable "reload context at the start of a session"
document and `CHANGELOG.md` an honest history — the two files this very project
directory keeps.

See [`../ARCHITECTURE.md#6-the-sweeper`](/architecture/overview#6-the-sweeper) for the
code path and [`../CONTRACT-v3.md`](https://github.com/edspencer/paddock/blob/main/docs/archive/CONTRACT-v3.md) for the original marker
contract.
