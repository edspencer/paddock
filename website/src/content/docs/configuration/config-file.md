---
title: "Config file (YAML)"
description: "Configure a Paddock instance from an optional YAML file instead of env-var sprawl — with environment variables still overriding it."
---

Paddock has always been configured from the environment ([every `PADDOCK_*`
variable is listed here](/configuration/environment/)). As the number of knobs
grew, so did the length of the `-e FOO=bar` list on the run command. Since
**v0.31** you can instead keep an instance's settings in a single **YAML file**
— and every environment variable still wins over it, so you can override one
value at run time without rewriting the file.

This page covers the file: where it lives, how it layers with the environment,
and a realistic example. It documents the same loader as the env-var page
(`packages/server/src/config.ts`), so the two are two views of one config.

## Precedence: file &lt; env, defaults beneath both

There is one resolution order, from lowest to highest priority:

1. **Built-in defaults** — the floor. Every setting has a sane default baked into
   the code (e.g. `PORT` → `4000`, `auth.mode` → `none`).
2. **The YAML file** — overrides the defaults. This is the **base layer**: each
   file value is threaded in as the fallback beneath the matching environment
   read.
3. **Environment variables** — override the file. A `PADDOCK_*` (or plain, e.g.
   `PORT`) env var **always wins** over the file value it shadows.

So the mental model is **defaults &lt; file &lt; env**. An env-only deployment is
completely unaffected: with no file present, resolution is byte-for-byte the
behaviour it had before the loader existed. You can adopt the file gradually —
move your stable settings into it and keep using env vars for the one or two you
tweak per run.

:::note[Same parsing either way]
A file value is coerced through the **same** parsing an env value gets, so all
the rules on the [environment page](/configuration/environment/#how-values-are-parsed)
— blank-is-unset, the `1`/`true`/`yes` boolean convention, unknown-enum-falls-
back-to-default, path canonicalisation — apply identically to file values. A
scalar may be written in its natural YAML type (`port: 4000`, `brand: { name:
Homelab }`) or as a string; both resolve the same way.
:::

## Where the file lives

Paddock looks for the file in one of two places:

- **`PADDOCK_CONFIG`** — if this env var is set, it's an explicit path to the
  file (wins over the default location).
- Otherwise **`<PADDOCK_DATA_DIR>/paddock.config.yaml`** — the default location,
  under your data directory (which defaults to `./data`).

The file is entirely optional:

- **No file → no-op.** If the default file doesn't exist, Paddock runs env-only,
  exactly as before. Existing installs need change nothing.
- **A missing *explicit* file is an error.** If `PADDOCK_CONFIG` points at a path
  that doesn't exist, that's treated as a misconfiguration — startup fails with a
  clear error rather than silently ignoring your intent.
- **A malformed file is an error.** Unparseable YAML, or a top-level list/scalar
  where a mapping is expected, fails startup with a clear message rather than
  booting with a half-empty config.
- **Empty sections are ignored, not fatal.** An empty file (or a comments-only
  one) is treated as "no overrides". A valueless key (`brand:` with nothing after
  it) is dropped, so that section falls back to env/defaults instead of crashing.
- **Unknown keys are ignored.** This leaves room for the schedule and hook
  declarations that share this file to be added without breaking older builds.

## An example config file

Keys mirror the resolved config: top-level scalars plus a few nested sections.
Every value below is optional and overridable by its matching env var. This is
the same YAML house style as `project.yaml` and the generated `herdctl.yaml`.

```yaml
# <PADDOCK_DATA_DIR>/paddock.config.yaml
# A home-lab instance. Every value here is overridable by its env var.

# --- Core ---
port: 4000
host: 0.0.0.0
logLevel: info

# --- Agent behaviour ---
keeperDriveMode: session      # session enables cross-turn autonomy (ScheduleWakeup / /loop)
nativeSystemPrompt: true      # use the native Claude Code prompt + CLAUDE.md hierarchy

# Appended to every keeper turn's system prompt. Omit the key entirely for
# Paddock's built-in text; set it to "" to append nothing. See
# /configuration/instance-settings/#the-environment-prompt
environmentPrompt: |
  You are running in Acme's Paddock — replies render as Markdown in a browser.
  Link every ticket as [ABC-123](https://acme.atlassian.net/browse/ABC-123).

# --- What this instance shares with the host's Claude Code (#691) ---
# `own` = Paddock's, isolated inside the data dir. `host` = this machine's
# Claude Code. Omit the block entirely for full isolation, which is the default:
# nothing outside the data dir is written.
claude:
  transcripts: own            # own | host — see the section below
  credentials: host           # own | host — the ONE key that defaults to host
  instructions: own           # own | host — your ~/.claude CLAUDE.md, agents, commands
  hooks: own                  # own | host — shell commands your settings.json binds

# --- Authentication (see the Authentication page for modes) ---
auth:
  mode: jwt
  jwksUrl: https://idp.example.com/application/o/paddock/jwks/
  jwtIssuer: https://idp.example.com/application/o/paddock/

# --- Per-instance branding (tell several instances apart) ---
brand:
  name: Homelab
  logo: "🏠"
  accent: "#3c6ec2"

# --- Capabilities & safety gates (default OFF; maxSpawnDepth defaults to 1) ---
selfMcpEnabled: true          # read-only self-management MCP for Claude
selfMcpWriteEnabled: true     # + the write tools (create/fork/send/archive/fan-out)
selfMcpProjectsEnabled: false # + create_project (provisions a project, clones a repo)
maxSpawnDepth: 1              # how deep spawned children may themselves spawn
scheduleMutationEnabled: false
hooksMcpEnabled: false        # + the trigger tools (list/set/remove/run_trigger)

# --- External Management API (/mcp) — file-first; only trustedProxies has an env var ---
managementApi:
  instanceId: my-paddock                    # binds `pdk_<instanceId>_…` tokens here
  publicUrl: https://paddock.example.com    # required once `clients` is set
  trustedProxies: [172.18.0.0/16]           # whose X-Forwarded-Proto the guard believes
  clients:
    my-laptop:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP  # env reference ONLY — inline is an error
      # omit `scope` for the read-only default

# --- Inbound composer attachments (file/image upload; all optional) ---
attachments:
  enabled: true                 # master switch (default on)
  maxFileSizeMb: 25             # per-file cap
  maxFilesPerMessage: 10        # per-message cap
  allowedTypes: ["*"]           # a real array here (env is comma-separated)

# --- Voice dictation (Whisper), git author, GitHub OAuth ---
transcription:
  mode: remote
  endpoint: https://whisper.example.com/v1
gitAuthor:
  name: Paddock
  email: paddock@localhost
```

Point Paddock at a file in a non-default place with `PADDOCK_CONFIG`:

```bash
PADDOCK_CONFIG=/etc/paddock/instance.yaml node packages/server/dist/index.js
```

## `claude` — what this instance shares with your Claude Code

Paddock drives Claude Code, which means it sits next to state you already have:
transcripts, a login, MCP servers, a `CLAUDE.md`. **By default it writes none of
it, and reads almost none of it.** A fresh instance keeps its own Claude home
under the data dir; the only thing it takes from your `~/.claude` unasked is your
login (see `credentials` below) and the non-executable half of your
`settings.json`. Everything else is a key you turn on.

Each key under `claude:` answers one question — *whose X does this instance use?*
— with one vocabulary, so the guarantee is readable at a glance rather than
inferred from which directory Paddock happens to be pointed at.

```yaml
claude:
  transcripts: own    # own | host — default own
  credentials: host   # own | host — default host
  instructions: own   # own | host — default own
  hooks: own          # own | host — default own
```

### `transcripts`

- **`own`** (default) — each project's chats live in its own `.chats/`, inside
  the data dir. Move the data dir and the whole instance moves with it. Deleting
  a chat deletes Paddock's copy.
- **`host`** — Paddock uses your real `~/.claude/projects/<encoded-cwd>/` folder
  for each project's working directory. One set of files, both directions: a chat
  you continue in the terminal with `claude --resume` shows up in Paddock without
  a restart or a re-import, and vice versa. Deleting a chat in Paddock
  **releases** it — the chat leaves your list and the transcript stays on disk,
  because it is your history rather than Paddock's copy (#689).

`host` is implemented as one symlink per project pointing *out* of Paddock's own
Claude home, not by pointing Paddock at `~/.claude`. That distinction is
load-bearing rather than cosmetic: agent memory lives beside the transcripts, and
an agent cannot write to any path containing a `.claude` component — so the home
that moves is the one thing that must not (#690). Paddock refuses to start if
`CLAUDE_CONFIG_DIR` or a `claudeHome:` key resolves to your own `~/.claude`, and
the refusal names this key as what you probably wanted.

### `credentials`

**The one key that defaults to `host`,** and the exception is deliberate:
isolation is about *writes*. Reading a login creates, moves and deletes nothing,
while defaulting it to `own` produces an instance that boots cleanly, says
everything is ready, and then fails every single turn with "Not logged in" —
which is exactly the bug this key closes (#683).

- **`host`** (default) — Paddock uses the Claude Code login already on this
  machine. On macOS that is the Keychain entry `claude /login` wrote; everywhere
  else it is your `~/.claude/.credentials.json`, symlinked into Paddock's home
  rather than copied, so a refreshed token is never duplicated or stale.
- **`own`** — Paddock uses only a login of its own: a `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_API_KEY` in the environment, or a `.credentials.json` inside its own
  Claude home (`CLAUDE_CONFIG_DIR=<data-dir>/claude-home claude login`). Nothing
  of yours is read. If a previous boot bridged your `.credentials.json` in, that
  symlink is removed on the next start.

The macOS half works because Claude Code resolves its secure-storage scope from
`CLAUDE_SECURESTORAGE_CONFIG_DIR` *instead of* `CLAUDE_CONFIG_DIR` whenever that
variable is defined. Paddock defines it as the **empty string**, which selects the
unsuffixed service name — your real login — while its own Claude home stays
exactly where it is. Nothing else is shared by this key: not transcripts, not
memory, not `.claude.json`. If you set `CLAUDE_SECURESTORAGE_CONFIG_DIR` yourself
to something non-empty, Paddock honours yours and says so at startup.

Paddock says which login it is running on when it has anything to report, and
warns before the first turn — rather than after it — when it can find none.

### `instructions`

Your `~/.claude/CLAUDE.md`, `agents/`, `commands/` and `plugins/` — prompts,
subagent definitions and slash commands. Content the model reads, or definitions
it can invoke by name; nothing here runs a command on its own.

- **`own`** (default) — none of them are loaded. Each project's own `CLAUDE.md`
  and `.claude/` are unaffected, and so is anything you put in Paddock's own
  Claude home.
- **`host`** — all four are symlinked in, which is what every version before
  0.62 did unconditionally.

**This default is a reversal, and it has a real cost.** If you have curated a
`~/.claude/CLAUDE.md`, `instructions: own` means your Paddock agents stop knowing
things they knew yesterday — with no error, just different behaviour. That is a
regression, and the argument against it is a good one. It is the default anyway
because *"`own` everywhere means nothing outside the data dir is read or
written"* has to be a guarantee you can read off this file, and *"…except your
CLAUDE.md, agents, commands and plugins, always, with no key to turn them off"*
is not a guarantee, it is a footnote. Paddock names the key at startup when it
finds files it is not loading, so the fix is one line and you are told where.

`plugins/` is bridged under `host` for completeness rather than effect: the Agent
SDK takes plugins per-session through its own option and does not auto-discover
installed ones the way the interactive CLI does, so today the directory is very
probably inert either way. That is a property of a caller, not of the files, so
the lever governs them regardless.

### `hooks`

Hooks are **shell commands** your `~/.claude/settings.json` binds to tool use and
session lifecycle (`PreToolUse`, `PostToolUse`, `SessionStart`, …). Before 0.62
they were inherited unconditionally, so every hook you had ever configured ran
inside every Paddock turn with no key to turn it off. This is that key.

- **`own`** (default) — your hooks do **not** run here.
- **`host`** — your `settings.json` is symlinked in whole and your hooks run.

`settings.json` is a mixed bag: it carries `hooks` *and* `permissions`, `model`,
`statusLine`, `enabledPlugins`. A symlink is all-or-nothing and the file is not,
so under `own` Paddock **writes its own `settings.json`** into its Claude home —
your keys, with `hooks` dropped. Two consequences worth knowing:

- **A restart is what applies an edit.** The generated file is regenerated at
  every startup, so changing your `~/.claude/settings.json` reaches Paddock on
  the next start rather than immediately. Only files that actually define hooks
  are copied at all; without them Paddock symlinks yours as before and nothing
  can go stale.
- **A `settings.json` you put in Paddock's own Claude home is never touched.**
  Paddock recognises its own generated file by hash, so editing that file makes
  it yours and Paddock stops regenerating it — and says at startup that `hooks:
  own` is therefore not in force for whatever that file says.

If your `~/.claude/settings.json` cannot be parsed, Paddock plants **nothing**
rather than falling back to the symlink: it would rather run with no user-level
settings than hand over the hooks this key exists to withhold.

**Scope, stated plainly:** `hooks: own` means "no host hooks", not "no host
commands". `settings.json` has several other keys that name a script to run —
`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`proxyAuthHelper`, `otelHeadersHelper`, `statusLine`, `subagentStatusLine` — and
they are still inherited. Several of those are how a corporate login *works*, so
dropping them under a key named `hooks` would break authentication for people who
did nothing wrong; where they belong is an open question (#691).

Still not split out, and inherited with the Claude home until it is: MCP servers,
tracked in #691.

## Capability & safety gates worth setting here

Several of the knobs above are **capability gates** that default to **off** — a
plain instance advertises none of them, and you opt in per instance. They are
prime candidates for the config file because they rarely change between runs.
Each is settable **either** in the YAML **or** via its env var (env wins), and
several also take a per-project override that wins at dispatch time.

The first four rows decide which of the fourteen `mcp__paddock_manage__*` tools
Claude is handed; the [self-management MCP reference](/reference/self-mcp/) lists
every tool, its arguments and the exact gating matrix.

| YAML key | Env var | Default | What it gates |
|----------|---------|---------|---------------|
| `selfMcpEnabled` | `PADDOCK_SELF_MCP` | `false` | Give Claude the read-only [self-management MCP](/reference/self-mcp/) (`mcp__paddock_manage__*`): `list_projects`, `list_chats`, `read_chat`. |
| `selfMcpWriteEnabled` | `PADDOCK_SELF_MCP_WRITE` | `false` | Add the self-management **write** tools: `create_chat`, `fork_chat`, `send_message`, `archive_chat`, `unarchive_chat`, `fork_chat_batch`. **Only honoured when `selfMcpEnabled` is also on** — write implies read. (The trigger tools are gated separately, by `hooksMcpEnabled` below.) |
| `selfMcpProjectsEnabled` | `PADDOCK_SELF_MCP_PROJECTS` | `false` | Add the self-management **project** tool (`create_project`) — provisioning a whole new project, cloning a repo when repo-backed. **Only honoured when `selfMcpWriteEnabled` (and so `selfMcpEnabled`) is also on.** Its own flag because it creates instance-level state and clones a caller-supplied URL; when off the tool is **absent**, not present-but-refusing. |
| `maxSpawnDepth` | `PADDOCK_MAX_SPAWN_DEPTH` | `1` | How deep a spawned chat may itself spawn: a **server-initiated** turn at depth `d` gets the self-MCP only if `d ≤ maxSpawnDepth`. `0` restores "no spawned child gets it"; valid values are `0`–`8`. A human turn is the depth-0 root and is never depth-gated. A per-project override wins at dispatch. |
| `scheduleMutationEnabled` | `PADDOCK_SCHEDULE_MUTATION` | `false` | Construct herdctl's fleet manager with `allowScheduleMutation`, permitting its runtime schedule add/remove APIs; off (the default) makes them throw. It is **not** what gates the self-MCP trigger tools (that's `hooksMcpEnabled`), and triggers declared in `project.yaml` are armed regardless. |
| `hooksMcpEnabled` | `PADDOCK_HOOKS_MCP` | `false` | Advertise the unified trigger-management MCP tools — `list_triggers`, `set_trigger`, `remove_trigger`, `run_trigger`. (There are no `list_hooks`/`set_hook`/`remove_hook` tools; Epic T collapsed the separate hook and schedule verbs into this one family, and kept this flag as their gate.) Only honoured alongside the self-MCP write tools; a per-project `hooksMcpEnabled` override wins at dispatch. |

### `managementApi` — the file-first block

The external [Management API](/reference/mcp/) is configured **here rather than in
the environment**, because a list of clients each with its own scope doesn't
express well as a scalar.

The one exception is **`trustedProxies`** — a flat list, and the thing a container
deployment most often needs to set per-environment. It also reads
`PADDOCK_MANAGEMENT_TRUSTED_PROXIES`, which **wins over the file**; that is the
only `PADDOCK_MANAGEMENT_*` variable Paddock reads.

`trustedProxies` names the peers whose `X-Forwarded-Proto: https` the `/mcp`
plaintext guard believes. The peer is the socket address, so a client can't forge
it — but a client also can't vouch for its own transport, which is why the list
exists ([#474](https://github.com/edspencer/paddock/issues/474), shipped in
0.48.1):

```yaml
managementApi:
  # Recommended: name your TLS terminator, and only its forwarded scheme is
  # believed. This is what makes the guard a control rather than a footgun-preventer.
  trustedProxies: [172.18.0.5]

  # The DEFAULT, if you omit the key entirely — equivalent to:
  #   trustedProxies: [loopback, linklocal, uniquelocal]
  # Loopback plus the whole private address space. Keeps a TLS-terminating
  # sidecar working, but can't tell your proxy from any other private host, so
  # believing a forwarded scheme under it logs a warning once per peer.
  #
  # Strictest — believe no forwarded scheme at all; reach /mcp over real TLS or
  # over loopback:
  #   trustedProxies: [none]
  #
  # The opposite, `all`, restores the pre-#474 behaviour and boots with a loud
  # warning. Only for a network you fully control.
```

A comma- or newline-delimited string works in place of the array, and an entry
that is not a valid IP, CIDR or preset is dropped with a logged error rather than
failing startup — dropping one can only make the guard stricter.

The one thing that never goes in this file is the **token itself**. This file is
git-tracked (and editable from the instance Config screen), so a client's
credential is given as an environment *reference* — `auth: { ref: "env:VAR" }` —
and an inline `token:`/`secret:` is a **hard config error**, not a warning.

The block fails closed in both directions: `/mcp` returns `404` until both
`clients` and `publicUrl` are set, and a client whose referenced variable is
unset, blank, or under 24 characters is dropped with a warning rather than
weakening the gate. A client with no `scope` gets **read-only** — any write scope
can start turns, and Claude has `Bash`. The
[Management API reference](/reference/mcp/#config-schema) has the full schema,
the scope grammar and a worked example.

For the full list of settings — auth headers, Whisper models, recovery knobs,
dev-server advertising, and more — see the
**[Environment variables reference](/configuration/environment/)**; every
`PADDOCK_*` server setting there has a matching YAML key. (The runtime
credentials — `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` — and the Vite
web-build variables are read straight from the environment and have no file key.)

## Per-project overrides layer on top

The YAML file sets **instance-wide** defaults. A handful of settings can then be
overridden **per project** from that project's **Settings** tab (persisted in its
`project.yaml`), which wins at dispatch time — for example `driveMode`,
`maxSpawnDepth`, `hooksMcpEnabled`, the chat `recovery` knobs, and the
`attachments` group (a project can raise/lower its upload caps or disable uploads
entirely). So the layering is: built-in default → instance YAML/env → per-project
override.

![A project's Settings tab, where agent behaviour set instance-wide in the config file can be overridden for this one project](../../../assets/config/project-settings.png)

## See also

- **[Environment variables](/configuration/environment/)** — the canonical list
  of every setting, with defaults, that this file mirrors.
- **[Authentication](/configuration/authentication/)** — auth modes and the
  `auth` section in detail.
- **[Chat recovery](/configuration/chat-recovery/)** — the `recovery` section and
  its per-project override.
