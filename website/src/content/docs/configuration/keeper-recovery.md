---
title: "Keeper-chat recovery"
description: "Why a keeper can hang silently when a background task is killed at the turn boundary, and how Paddock's configurable recovery surfaces and re-drives it."
---

Sometimes a keeper chat just… stops. The keeper kicked off some background work,
its turn ended, and then nothing — no reply, no error, no obvious reason. The chat
sits there until someone types a message to nudge it back to life.

This page explains **why that happens**, what Paddock does about it, and how to
configure it.

## The backstory — why a keeper hangs

Keepers run in a persistent session (see [Chats are sessions](/concepts/chats)).
Within a turn, a keeper can launch **background work** — a background `Bash`
command, or a background `Task`/`Agent` sub-agent — and then finish its turn while
that work is still running. That is a normal, useful pattern: start a long build,
end the turn, get woken when it completes.

The problem is a race at the **turn boundary**:

1. The orchestration engine (herdctl) sees the still-running task in its end-of-turn
   snapshot and **correctly keeps the session alive** — it does *not* shut it down,
   because there's outstanding work.
2. But the underlying Claude Agent SDK / native CLI **kills the still-running
   background child anyway**, a couple of seconds after the turn ends.
3. Here's the crucial asymmetry. A task that **completes** emits a follow-up
   notification that *wakes the keeper* — it gets another turn and carries on. A
   task that is **killed** writes a `killed`/`stopped` `<task-notification>` to the
   transcript but **wakes nothing**. Nobody is listening.
4. The session is still alive — but idle, forever. It only recovers when a **human
   sends the next message**.

To make it worse, the killed notification was, until now, **hidden** in the chat
UI, and the canned summary sometimes reads *"was stopped by user"* even though no
user did anything — so the chat looks like it silently died for no reason.

This is an upstream limitation, not a Paddock bug — the root-cause analysis lives in
[herdctl#374](https://github.com/edspencer/herdctl/issues/374). Paddock ships a
pragmatic **app-side workaround**, because the one thing we *can* rely on is that
**the session stays alive and injectable**. Recovering a hung keeper is therefore
exactly "automate the nudge a human already sends by hand."

## What the fix is — two layers

Recovery is delivered in two independently-toggleable layers:

- **Layer 2 — visibility + manual recovery (default ON).** The killed/stopped
  notification is surfaced as a clear affordance in the chat, with a one-click
  **Continue** button that re-drives the keeper. Pure visibility plus a manual
  button is low-risk, so it's on by default.
- **Layer 3 — automatic recovery (default OFF).** Paddock detects the killed task
  and injects the re-drive nudge on its own, so the keeper wakes without anyone
  watching. Because it acts automatically and costs a turn (and tokens), it's
  opt-in. This is now **live** — see [Layer 3 — automatic recovery](#layer-3--automatic-recovery-now-live)
  below.

Both layers are configured the same way — an instance-wide default with an optional
per-project override, exactly like [`driveMode` and
`maxSpawnDepth`](/configuration/environment).

## Layer 2 in the chat — the Continue button

When a keeper's background task is killed at the turn boundary, its chat now shows
an amber notice instead of silently stopping:

> ⚠ A background task was terminated at the turn boundary — the keeper is idle and
> will not continue on its own.

If Layer 2 is enabled (it is by default), the notice carries a **Continue** button.
Clicking it injects a recovery nudge into the still-alive session. The nudge tells
the keeper the truth — that its background task was **killed at the turn boundary**
(a runtime limitation, *not* a user cancellation) — so it reacts sensibly: it
re-runs the work in the **foreground** this turn, or summarises what happened and
carries on. The re-drive streams back live and is recorded in the transcript,
attributed to Paddock recovery (⚠ *continued after a background task was
terminated*) so it's clear the turn wasn't human-typed.

Turning Layer 2 **off** keeps the explanatory notice (so the hang is still visible)
but removes the Continue button, and the server refuses a recovery re-drive for that
project.

## Layer 3 — automatic recovery (now live)

With Layer 3 enabled, no one has to be watching the chat. Paddock notices the hung
keeper and sends the same nudge the Continue button does — on its own.

### How it detects a hang

Layer 3 rides on the one fact we can rely on: the session stays alive and its
transcript is the source of truth. After **every session-mode keeper turn**, Paddock
arms a short **post-turn watch** on that chat's transcript:

1. A background task that **completes** wakes the keeper — new assistant activity
   appends to the transcript. A task that is **killed** writes a terminated
   `<task-notification>` that wakes nothing, and no assistant activity follows.
2. So the hung signature is simple: the transcript ends with a **terminated
   task-notification and no keeper reply after it**. If instead the keeper wakes on
   its own inside the watch window, the watch sees that reply and stands down.
3. The kill lands a couple of seconds *after* the turn ends, so the watch keeps
   polling for a short grace period, and only acts once the notification has sat
   un-answered for the full **debounce** window.

When that signature holds and Layer 3 is on, Paddock injects the recovery nudge into
the still-alive session — the identical re-drive the manual **Continue** button
performs (attributed to Paddock recovery, streamed live, recorded in the transcript).
The keeper wakes, sees its task was killed at the turn boundary, and carries on.

### The guards (so it can't misfire or loop)

Auto-recovery is deliberately cautious:

- **Opt-in.** It only ever fires when `autoReDrive` is on for the project (per-project
  override, else the instance default). With Layer 3 off, the watch is never even
  armed.
- **Debounce.** It never fires until the killed notification has been quiet for
  `debounceMs` (default 5s). A keeper that's genuinely finishing — or that wakes
  itself — inside that window is left alone.
- **Retry cap.** Each session may be auto re-driven at most `maxRetries` times
  (default 1). A permanently-wedged keeper (one that hangs again the same way after a
  re-drive) is nudged up to the cap and then left alone — no poke-loop.
- **Human reset.** When a human next sends a message to the chat, the retry
  bookkeeping resets, so a genuinely-new hang later on is recovered fresh. (The cap
  counts auto re-drives *between* human messages.)
- **No double-dispatch.** The nudge is only ever injected into a genuinely *idle*
  session. If something else is already driving the chat by the time recovery would
  act — a human message, a queued follow-up, or the manual **Continue** button —
  recovery stands down and lets that turn proceed. (Resuming a session that already
  has a live turn would interrupt it, so the first nudge could otherwise be
  swallowed; this guard makes the re-drive land reliably.)

### Enabling it

Turn it on instance-wide, or just for the projects that want it:

```bash
# instance-wide
PADDOCK_RECOVERY_AUTODRIVE=1
```

```yaml
# project.yaml — opt one project in (leaving the instance default OFF)
recovery:
  autoReDrive: true
  # optional: tune the guards for this project
  debounceMs: 5000
  maxRetries: 1
```

Because it spends a turn and tokens without a human in the loop, it stays **off by
default** — Layer 2 (see it, click to fix it) is the safe default, and Layer 3 is the
hands-off upgrade for chats you want to keep moving unattended.

## How to enable and configure it

Every knob is an instance default with a per-project override. Precedence is, from
lowest to highest: **built-in default → YAML instance file → environment variable →
per-project `recovery` override**.

### Instance defaults

Set these in the environment (or the YAML instance-config file under a top-level
`recovery:` mapping):

| Setting | Env var | Default | Layer | What it does |
| --- | --- | --- | --- | --- |
| `surfaceKilledTask` | `PADDOCK_RECOVERY_SURFACE` | `true` (ON) | 2 | Surface the killed-task notice + the manual **Continue** button. |
| `autoReDrive` | `PADDOCK_RECOVERY_AUTODRIVE` | `false` (OFF) | 3 | Automatically re-drive a hung keeper (detect the killed task + inject the nudge on its own). |
| `debounceMs` | `PADDOCK_RECOVERY_DEBOUNCE_MS` | `5000` | 3 | Quiet window (ms) after a killed task before auto re-drive fires, so a keeper that's genuinely finishing isn't poked. |
| `maxRetries` | `PADDOCK_RECOVERY_MAX_RETRIES` | `1` | 3 | Per-session cap on auto re-drives, so a wedged keeper isn't poked in a loop. |
| `limboTimeoutMs` | `PADDOCK_RECOVERY_LIMBO_MS` | `0` (off) | 2 | If set, surface a kept-alive session as stuck after this many ms of silence following a killed task. `0` disables it. *(Backstop timer ships in a follow-up.)* |

Booleans accept `1`/`true`/`yes` (case-insensitive) for on and anything else for
off. The numeric knobs accept non-negative integers; an invalid value falls back to
the default rather than failing startup.

In a YAML instance-config file the same settings look like:

```yaml
recovery:
  surfaceKilledTask: true
  autoReDrive: false
  debounceMs: 5000
  maxRetries: 1
  limboTimeoutMs: 0
```

### Per-project override

Any project can override any subset of the recovery settings in its `project.yaml`.
Fields you don't set inherit the instance default:

```yaml
# project.yaml
recovery:
  surfaceKilledTask: false   # e.g. hide the Continue button for this project
```

Removing the `recovery` block (or clearing it via the API) reverts the project to
the instance defaults for every field.

## Frequently asked

**Does this change herdctl's keep-alive behaviour?** No. herdctl is already doing
the right thing by keeping the session alive; this is a purely app-side complement
that rides on that. The ideal upstream fix (the runtime making a killed task wake
its parent) is tracked separately in
[herdctl#374](https://github.com/edspencer/herdctl/issues/374).

**Why not just always auto-recover?** Auto-recovery (Layer 3) spends a turn and
tokens and acts without a human in the loop, so it's opt-in per instance/project.
Layer 2 — see it, click to fix it — is the safe default.

**What about the "stopped by user" wording?** That canned summary can appear even
when no user acted; it's the same underlying turn-boundary kill. The recovery nudge
explicitly tells the keeper it was a runtime kill, not a cancellation, so it doesn't
draw the wrong conclusion.
