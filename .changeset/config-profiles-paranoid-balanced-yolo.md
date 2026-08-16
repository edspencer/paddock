---
"@paddock/server": minor
---

Config profiles (#878): one key picks an instance's security posture instead of
a dozen `PADDOCK_*` variables. `profile: paranoid | balanced | yolo` in
`paddock.config.yaml`, `PADDOCK_PROFILE` in the environment, and a code default
underneath both — so a native install, a container and a bare `node dist` all
converge on the same posture. An installer that materialised concrete values
into the config file could not have done this: it only ever touches the file
layer, which is the one path a container never runs.

A profile supplies the **defaults** for the five `claude.*` sharing modes,
`maxSpawnDepth` and the six capability toggles, and nothing else — it is silent
on port, bind host, auth, models, drive mode and the rest, so switching profile
cannot change your port or clobber your auth config. In particular **`yolo` does
not open the bind address or relax authentication**; network exposure stays its
own explicit decision.

**The default is `balanced`, and that is a behaviour change on upgrade.** An
instance with no config file and no overrides previously resolved to what is now
`paranoid`; it will now inherit the host's `instructions` and `mcpServers` (and
the plugins that ride on the former), and gain the read-only self-management
MCP. Mostly inert in a container (there is usually no populated `~/.claude` to
inherit from), real on a workstation. `profile: paranoid` restores the old
behaviour exactly — a test pins the preset against the previous code defaults,
so that is a guarantee rather than an intention.

The reasoning for the default is the superset principle: Paddock is a
presentation layer over the Claude Code CLI, so its capability surface should be
a superset of what the plain CLI already gives you. MCP servers you configured
for your CLI silently not working under Paddock is a capability regression
against the tool it wraps.

Two levers deliberately do not ride along. **`hooks`** is `host` only under
`yolo`: host hooks are shell commands that fire automatically on every matching
tool call, a different risk class from a tool an agent chooses to call. And
**`transcripts` stays `own` through `balanced`** — where your chat history lives
is not a capability, sharing it makes Paddock no more capable, and it changes
what an existing action means (under `host`, deleting a chat *releases* the
transcript rather than removing it, #689). So your chats stay Paddock's own by
default and nothing moves on upgrade.

One precedence wrinkle worth knowing: an individual key in the config file beats
`PADDOCK_PROFILE` in the environment, inverting Paddock's usual
environment-always-wins rule. *Specific beats general* — `PADDOCK_PROFILE`
speaks for the levers you did not mention. Environment still wins over the file
for the same key.
