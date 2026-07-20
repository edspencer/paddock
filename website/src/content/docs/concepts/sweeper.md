---
title: "The sweeper"
description: "The post-turn, tool-less agent that curates each project OVERVIEW and CHANGELOG."
---

The **sweeper** keeps a project's notes current without you having to. After each
of your chat turns in a project, a per-project, **tool-less** curation agent reads
what just happened and updates two files: `OVERVIEW.md` (the current state) and
`CHANGELOG.md` (the running history). It runs quietly, out of band — you never
chat with it.

:::note[The sweeper is now a trigger]
Since **v0.37** the sweeper is the project's **implicit default `curate-overview`
trigger** — an [`afterTurn` event trigger](/concepts/schedules/#what-a-schedule-is).
Nothing to configure: a project that declares no such trigger curates exactly as
described here. Declaring one only *customises* the default (a different model, an
extra prompt) or turns it **off** — see [Customise or disable it](#customise-or-disable-it).
:::

## What it is

- **Per project.** Each project has its own `sweeper-<slug>` agent, whose working
  directory is the project's **metadata dir** (agents bind to a cwd, so the
  sweeper can't share one across projects).
- **Tool-less.** The sweeper is configured with `allowed_tools: []` and a small
  model (`SWEEPER_DEFAULT_MODEL`, Haiku by default, `max_turns: 4`). It cannot
  touch the working tree, run commands, or start other chats. It only *returns
  text*; Paddock's `SweepService` (`sweep.ts`) parses that text and writes the
  files. This is a safety and cost property: a curation pass can never mutate your
  code and can never trigger another sweep.

## When it runs

1. Every completed, **non-scratch** turn — a human chat turn, a session-mode
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

The sweeper is prompted with a **digest** of recent activity (the last ~40
messages of the 3 newest chats), plus the current `OVERVIEW.md`, `CHANGELOG.md`
tail, and `CLAUDE.md`. It must reply with exactly three marked sections as plain
text:

```
<<<OVERVIEW>>>
…full markdown snapshot of the project's current state…
<<<CHANGELOG>>>
…one bare bullet line summarizing this activity (no leading "- ", no date)…
<<<CLAUDE>>>
…genuinely-new durable facts to append, or the literal NOCHANGE…
<<<END>>>
```

`SweepService` parses the markers and writes the files itself:

- **`OVERVIEW.md`** — replaced **wholesale** each sweep. It's a synthesized "what
  this project is, key decisions, open questions, next steps" written for an LLM
  to read at the start of a new chat (and offered as the optional preload context
  on a new chat).
- **`CHANGELOG.md`** — the single bullet is **appended** under today's
  `## YYYY-MM-DD` heading (the service adds the `- ` and the date).
- **`CLAUDE.md`** — amended **only** with genuinely-new durable facts, and
  **never for a repo-backed project** (whose `CLAUDE.md` is upstream-owned).

If the markers are missing or unparseable, the sweep throws — the activity
watermark doesn't advance and no partial/garbage content is written. Every sweep
failure is non-fatal to your chat.

## Customise or disable it

The sweeper is the default **`curate-overview`** trigger, so you shape it the same
way you shape any trigger — by declaring one in the project's `project.yaml` (or
from a keeper chat with the trigger-management tools). A project that declares
nothing behaves exactly as above; a declared `curate-overview` trigger only
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
