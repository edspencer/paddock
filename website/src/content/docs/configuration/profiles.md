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
| `claude.transcripts` | `own` | **`host`** | `host` |
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
the tool Paddock wraps. So `balanced` inherits your instructions, MCP servers and
transcripts, and turns on the read-only self-management MCP, while leaving the
genuinely additive capabilities off.

**`yolo`** turns everything on.

Two choices in that table are deliberate and worth explaining:

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

One knock-on worth knowing: `transcripts: host` plants transcript-redirect
symlinks into `~/.claude/projects`, which couples the instance to your host
transcript store — and to any other instance doing the same.

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
already has — never on `yolo`.

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
`PADDOCK_*` overrides gains host `instructions`, `mcpServers` and `transcripts`
on upgrade.

In a container that is mostly inert — there is usually no populated `~/.claude`
to inherit from. On a workstation it is a real change.

To keep exactly the old behaviour, say so explicitly:

```yaml
profile: paranoid
```

That is a no-op against pre-profile Paddock: `paranoid` is the old code defaults,
unchanged, and a test pins it that way.
