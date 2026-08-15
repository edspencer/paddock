---
title: "Config profiles"
description: "Pick a security posture for a Paddock instance in one line — paranoid, balanced or yolo — instead of hand-setting a dozen capability levers."
---

Paddock has about a dozen independent security and capability levers: what it
shares with the Claude Code CLI already on your machine, how deep agents may
spawn sub-agents, and which self-management tools they get. Setting those one at
a time means a dozen `PADDOCK_*` variables on your run command, and no single
place that says what posture you actually wanted.

A **profile** is that single place.

```yaml
# paddock.config.yaml
profile: balanced
```

```bash
# or, identically — this is what Docker and compose use
PADDOCK_PROFILE=balanced
```

There are three, and they are a closed set: `paranoid`, `balanced` and `yolo`.

## What each one gives you

| Lever | `paranoid` | `balanced` *(default)* | `yolo` |
| --- | --- | --- | --- |
| `claude.transcripts` | `own` | `own` | **`host`** |
| `claude.credentials` | `host` | `host` | `host` |
| `claude.instructions` | `own` | **`host`** | `host` |
| `claude.hooks` | `own` | `own` | **`host`** |
| `claude.mcpServers` | `own` | **`host`** | `host` |
| `maxSpawnDepth` | 1 | 1 | **2** |
| Self-MCP (read) | off | **on** | on |
| Self-MCP write | off | off | **on** |
| Self-MCP projects | off | off | **on** |
| Schedule mutation | off | off | **on** |
| Hooks MCP | off | off | **on** |
| Browser MCP | off | off | **on** |

**`paranoid`** is fully isolated: Paddock shares nothing with your CLI except the
login, and every capability is off.

**`balanced`** is the default. Paddock is a presentation layer over the Claude
Code CLI, so its capability surface should be a *superset* of what the plain CLI
already gives you — if you have MCP servers configured for your CLI, they should
work here. Defaulting them off is experienced as a capability regression against
the tool Paddock wraps. So `balanced` inherits your instructions and MCP servers
(and the plugins that ride on the former), and turns on the read-only
self-management MCP, while leaving the genuinely additive capabilities off.

**`yolo`** turns everything on.

Three choices in that table are deliberate and worth explaining:

- **Your transcripts stay Paddock's own until `yolo`.** The superset argument is
  about *capability* — the MCP servers and instructions you already configured
  ought to work. Where your chat history physically lives is a different
  question. Sharing it makes Paddock no more capable, and it changes what an
  existing action means: under `host`, deleting a chat **releases** the
  transcript instead of removing it, because it is your history rather than
  Paddock's copy. So a stock Paddock keeps its chats to itself, and you can try
  it without it touching your CLI history at all. When you *do* want them
  merged, Paddock offers a guided migration rather than a config edit.

- **Host hooks are `own` until `yolo`.** Hooks are shell commands that fire
  *automatically* on every matching tool call — inherited arbitrary code
  execution. That is a different risk class from MCP servers, which are tools an
  agent deliberately chooses to call, so hooks do not ride along with the other
  `host` modes.
- **Browser MCP is off in `balanced`** because it needs a browser installed on
  the box. Enabling it where there isn't one leads agents to fall back to
  scripting your system browser instead, which is worse than not having it.

## The profile sets the levers; your environment sets the blast radius

`host` resolves against whatever `~/.claude` actually exists. On a workstation
that is a real, populated CLI install. In a container it is typically empty
unless you mounted or baked one in.

So the same profile produces a rich posture on your laptop and a naturally
contained one in a container — which is why the permissive profiles are far more
reasonable on a disposable container than on your primary machine.

One knock-on worth knowing about `yolo`: `transcripts: host` plants
transcript-redirect symlinks into `~/.claude/projects`, which couples the
instance to your host transcript store — and to any other instance doing the
same. That coupling is the main reason it is not on below `yolo`.

## Overriding a single lever

A profile only supplies **defaults**. Anything you set explicitly still wins, so
"a profile plus a few overrides" is the normal way to run:

```yaml
profile: paranoid       # locked down...
selfMcpEnabled: true    # ...but I want the read-only tools
```

The full precedence chain is:

```
code-default profile  <  your profile  <  an individual key in the file  <  an individual env var
```

:::caution[An individual key in the file beats `PADDOCK_PROFILE` in the env]
This is the one place Paddock inverts its usual "environment always wins" rule.

`PADDOCK_PROFILE=paranoid` with `claude: {hooks: host}` in a mounted config file
resolves hooks to **`host`**.

The reasoning is *specific beats general*: `PADDOCK_PROFILE` is a statement about
the dozen levers you did **not** mention, while a key you wrote by hand is a
statement about the one you did. The alternative would let the env var silently
discard deliberate per-key configuration.

Environment still wins over the file for the **same** key, exactly as everywhere
else — `PADDOCK_CLAUDE_HOOKS` beats `claude.hooks`.
:::

An unrecognised profile name does not fail the boot; it falls back to
`balanced`. A typo can only ever land you on the posture a config-less instance
already has — never on `yolo`. It is not silent, though: `paddock config show`
names the typo (see below), which is the only place you will find out.

## Seeing what your profile actually resolved to

A thin config file is the point, but it does leave a fair question: *so what am
I actually running?* The answer is a command, not a longer file:

```bash
paddock config show --resolved
```

It prints every effective setting **with the layer it came from** — and because
it resolves config through the same loader the server boots with, it cannot
drift from what your instance actually does.

```
Paddock config — every effective value, and the layer it came from
  Data dir     /home/you/.paddock
  Config file  /home/you/.paddock/paddock.config.yaml
  Profile      yolo  (config file)

Capabilities
  selfMcpEnabled            true      profile (yolo)
  selfMcpWriteEnabled       true      profile (yolo)
  maxSpawnDepth             2         profile (yolo)
  ...

Advanced (read-only)
  claude.transcripts        host      profile (yolo)
  claude.hooks              own       file
  claude.mcpServers         host      env PADDOCK_CLAUDE_MCP_SERVERS
```

Four layers can win, and each row names the one that did:

| Label | Means |
| --- | --- |
| `default` | Paddock's built-in default. |
| `profile (<name>)` | Your profile. **Distinct from `default` on purpose** — the twelve levers in the table above have no code default of their own any more, so this row is one a different profile would change. |
| `file` | A key in `paddock.config.yaml`. |
| `env <NAME>` | An environment variable, which beats the file for the same key. |

The last two rows of that example are the precedence inversion from the caution
above, shown rather than described: `claude.hooks: own` in the file beats a
`profile: yolo` that says `host`, while `PADDOCK_CLAUDE_MCP_SERVERS` in the
environment beats both.

Without `--resolved`, `paddock config show` prints just the **decisions** — your
profile, the keys your file sets, the variables your environment sets. Either
way it also calls out a key you wrote in the file that is *not* in effect
because something beat it, which is otherwise very hard to notice:

```
Set in the config file but NOT in effect
  brand.name  file says QA Rig — PADDOCK_BRAND_NAME wins for the same key
```

The command starts no server and writes nothing — not even the data directory,
which it reports as missing rather than creating. Values of fields marked
sensitive are shown as `(hidden)`; pass `--show-sensitive` to print them, or
`--json` for the whole report in machine-readable form.

Use `-d/--data-dir` to inspect an instance other than the default one — the same
rule `paddock start` uses, so the two always read the same instance.

## Freezing it into the file: `paddock config eject`

A thin file plus `config show` is the recommended way to run, but it is not the
only reasonable one. If you want the posture **pinned in git**, reviewable in a
diff, and identical across a fleet regardless of what a later release decides a
good default is, `eject` materialises the whole resolution into
`paddock.config.yaml`:

```bash
paddock config eject           # print what it would write — changes nothing
paddock config eject --write   # actually write it
```

It previews by default. Ejecting changes what the file *means* rather than what
it says, and it spreads that change across roughly forty keys where no single one
looks like a decision — so the plan is printed first, with its cost, and `--write`
is where you agree to it. (A flag rather than a prompt, so a container build or an
Ansible task can call it.)

:::caution[An ejected file stops inheriting improved defaults]
This is the tradeoff, and it is the whole reason the thin file is the default.
Every key eject writes becomes yours to maintain:

- **`models`** is pinned to today's catalog. A model added in a later release
  will not be offered by this instance until you re-run eject.
- **`environmentPrompt`** is pinned to the current text, so improvements to what
  agents are told about running inside Paddock stop reaching you.
- A **lever added in a later release** will not be in the file at all, so the file
  stops being the complete record you ejected it to be. Re-run eject after
  upgrades to keep it complete.

None of it is one-way: delete the keys you would rather inherit again, leave
`profile:` in place, and they go back to following it.
:::

### What it writes, and what it deliberately does not

It writes the twelve posture levers your profile expanded to, plus the
behavioural settings the Config screen already round-trips through this file.
Your comments and any keys Paddock does not manage survive — the file is
round-tripped, not regenerated — and the write is atomic.

Three categories are left out on purpose:

| Left out | Why |
| --- | --- |
| **Machine bindings** — `port`, `host`, `dataDir`, `projectsRoot`, `stateDir`, `herdctlConfigPath`, `webDist` | These resolve to absolute paths on *this* machine, and `dataDir` resolves to the directory holding the file itself. Ejecting them makes the file unportable and unmountable, and freezing a port is how a second instance started from the same file collides on boot. |
| **Sensitive keys** — `transcription.endpoint`, `auth.mode`, `githubClientId` | `transcription.endpoint` is a URL you supplied and can read `https://user:token@host`. Bulk-writing a credential-shaped value to disk should not be one keystroke away. Set such a key by hand instead. |
| **Values an environment variable supplies** | See below. |

### Why env-supplied values are skipped

An environment variable **beats the file**. So writing its current value into the
file changes nothing today — and changes this instance on the day that variable
stops being set. That is a deferred, silent transfer of a decision out of your
environment and into a file, with nothing recording that it was ever an
environment decision. It is also how a stray `PADDOCK_*` left over on a build box
gets baked into a committed config forever.

So eject names each one it skipped, and which variable owns it:

```
Not written
  2 keys the environment supplies — an environment variable beats the
  file, so freezing its value here would change nothing now and change this
  instance the day the variable goes away. Pass --include-env to write them.
    selfMcpWriteEnabled  PADDOCK_SELF_MCP_WRITE
    brand.name           PADDOCK_BRAND_NAME
```

`--include-env` writes them anyway. That is the right flag for the one case that
genuinely wants it: deliberately migrating an instance off a wall of `PADDOCK_*`
variables and into a file.

### `profile:` is written too

Even after a full eject — when every key the profile governs is explicit and the
line is therefore inert today — eject writes `profile:` as well.

That line is what a lever added in a **future** release falls back to. Without it,
a new capability toggle would resolve against the built-in default profile rather
than the posture you actually froze: eject from `paranoid`, upgrade, and silently
acquire `balanced`'s answer to a lever you have never heard of. That is exactly
the drift ejecting is supposed to protect you from.

It is also written when `PADDOCK_PROFILE` chose the profile, which is the one
deliberate exception to the env rule above — the line governs no key that
currently exists, so it cannot change any current value.

### Checking your work

The strongest thing you can do after ejecting is compare the resolution either
side of it. The effective values should be identical, with only the *layer*
having moved:

```bash
paddock config show --resolved   # before: posture keys read `profile (yolo)`
paddock config eject --write
paddock config show --resolved   # after:  the same values, now reading `file`
```

Re-running `paddock config eject` on an already-ejected instance is the quickest
way to find out whether an upgrade added a lever — it reports `Nothing to write`
when the file is still complete.

## What profiles will never touch

Profiles govern **posture keys only**. They are silent on operational settings:
port, data directory, bind host, authentication, model allow-lists, drive mode,
recovery, attachments, curation and git author. Switching profile must never
change your port or clobber your auth config.

In particular, **`yolo` does not open the bind address or relax authentication.**
Network exposure stays a separate, explicit decision — it still requires the
[dangerous-allow-open opt-in](/configuration/binding-and-exposure/). Otherwise
"yolo" would quietly mean "yolo, reachable from the whole network".

## Profiles and projects

`profile:` is an **instance-level** key. Projects do not have profiles.

Two posture levers — `maxSpawnDepth` and `hooksMcpEnabled` — can still be
overridden per project in `project.yaml`, exactly as they could before. The
profile sets the instance default those overrides start from; it is not a
ceiling, so a project can raise `maxSpawnDepth` above what the profile chose.

## Custom profiles

There aren't any, deliberately. `profile: paranoid` plus three overrides *is* a
custom profile — it just doesn't have a name. A system for named, shareable
profiles needs discovery, collision and versioning rules, and it has a real
blocker: a profile that flips write-side self-MCP and raises spawn depth is a
security-relevant artifact, and making profiles shareable invites importing one
from a source you don't control.

If you want one posture across many instances today, mount a config file or share
a compose fragment.

## Upgrading from before profiles

The default is `balanced`, and before profiles existed the built-in defaults were
equivalent to **`paranoid`**. So an instance with no config file and no
`PADDOCK_*` overrides gains host `instructions` and `mcpServers` on upgrade,
along with the read-only self-management MCP.

In a container that is mostly inert — there is usually no populated `~/.claude`
to inherit from. On a workstation it is a real change.

Your **transcripts are not affected**: `balanced` leaves them `own`, exactly as
before, so no chat moves and chat deletion keeps deleting.

To keep exactly the old behaviour, say so explicitly:

```yaml
profile: paranoid
```

That is a no-op against pre-profile Paddock: `paranoid` is the old code defaults,
unchanged, and a test pins it that way.
