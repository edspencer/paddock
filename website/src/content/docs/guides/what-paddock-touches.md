---
title: What Paddock touches on your machine
description: "Exactly which files and directories a Paddock instance reads, writes and never opens — the default posture, what each claude: key changes, and how to verify it yourself."
---

Paddock drives Claude Code, so it runs next to state you already have: a login,
transcripts, a curated `CLAUDE.md`, maybe an MCP server or two. This page is the
single answer to *what does it actually touch?* — stated as a guarantee you can
read rather than a property you have to infer.

Every switch mentioned here lives in the [`claude:` block of
`paddock.config.yaml`](/configuration/config-file/#claude--what-this-instance-shares-with-your-claude-code),
which has the per-key detail. This page is the summary and the default posture.

## The short version

**Out of the box, Paddock keeps everything inside its own data directory, with
one deliberate exception: it uses the Claude Code login you already have.**

That exception exists because isolation is about *writes*. Reading a login
creates, moves and deletes nothing — and defaulting it the other way produces an
instance that boots cleanly, reports itself ready, and then fails every single
turn with `Not logged in`.

## The default posture, file by file

| On your machine | By default | Governed by |
|---|---|---|
| `~/.claude/.credentials.json` (Linux, Docker) | **read** — symlinked in, never copied | [`credentials`](/configuration/config-file/#credentials) |
| macOS Keychain login | **read** — the unscoped entry `claude /login` wrote | [`credentials`](/configuration/config-file/#credentials) |
| `~/.claude/settings.json` | **read** — see [below](#the-settingsjson-special-case) | [`hooks`](/configuration/config-file/#hooks) |
| `~/.claude/CLAUDE.md` | not read | [`instructions`](/configuration/config-file/#instructions) |
| `~/.claude/agents/`, `commands/`, `plugins/` | not read | [`instructions`](/configuration/config-file/#instructions) |
| `~/.claude/projects/` (your transcripts) | not read and not written, with one exception you have to click: see [below](#the-one-thing-that-touches-your-transcript-folder) | [`transcripts`](/configuration/config-file/#transcripts) |
| `~/.claude.json` (your MCP servers) | not opened | [`mcpServers`](/configuration/config-file/#mcpservers) |
| `~/Library/LaunchAgents/`, `~/.config/systemd/user/` | not touched, unless you run [`paddock service install`](/guides/running-as-a-service/) | — |
| Anything else in `$HOME` | not touched | — |
| The directory you ran `paddock` in | not touched — it has no bearing on anything | — |
| A directory you link as a project | **read and written by the agent working in it**, and nothing else | — |

**Nothing in that table is written to by default.** Paddock makes exactly three
writes outside its data directory, and none of them happens unless you ask for
it:

- Under `transcripts: host`, it creates (`mkdir -p`) the encoded project folder
  under `~/.claude/projects/` — a directory Claude Code itself would create the
  first time you ran `claude` there.
- **The `own → host` migration**, and only when you run it from the button that
  offers it. It moves transcripts *into* `~/.claude/projects/`. See
  [below](#the-one-thing-that-touches-your-transcript-folder).
- `paddock service install` writes one unit file, at
  `~/Library/LaunchAgents/net.edspencer.paddock.plist` on macOS or
  `~/.config/systemd/user/paddock.service` on Linux. `paddock service uninstall`
  removes it. Nothing else on the machine changes, and the file holds no
  credential — see
  [Keeping Paddock running on your laptop](/guides/running-as-a-service/).

## The one thing that touches your transcript folder

Under `transcripts: own` — the default — Paddock keeps its chats in each
project's `.chats/` and never touches `~/.claude/projects/`. There is one
exception, and it only happens when you click.

If you later want your Paddock chats to *be* your Claude Code chats, Paddock
offers to move them for you rather than leaving you a manual `mv` to get right.
That is two things, and it is worth separating them:

**The preview reads.** Working out what the move would do means comparing the
two sides — a chat that exists only in Paddock is new, a chat that exists in
both may have been added to on either side — and that comparison has to read
`~/.claude/projects/`. It reads only; it runs when you open the preview, not on
a timer and not in the background.

**The migration itself writes** — that is what you asked it to do. Three
promises bound it, and they are the reason it is safe to say yes to:

- **Nothing is ever deleted.** Not by the migration, not on either side.
- **Nothing in `~/.claude` is overwritten in place.** Where the same chat exists
  in both places and Paddock's copy is the one that survives, *your* copy is
  moved out of the way first — never replaced under it.
- **The copy that does not survive is kept**, in
  `<project-dir>/.chats-pre-migration/`, and the completion screen lists every
  file by path. If you disagree with an outcome, the file is still there.

Your agent memory (`memory/`) is merged file by file under the same rule: a file
you already have is never overwritten, and Paddock's copy is set aside for you
to merge by hand instead.

## Where Paddock's own state lives

Everything else is in one directory — `~/.paddock` unless you pass `--data-dir`.
Move it to move the instance; delete it to start over. Where you ran `paddock`
from does not enter into it.

Inside it, the piece that matters here is **`<data-dir>/claude-home`**: Paddock's
own Claude home, which it always owns. It is not your `~/.claude` and cannot be
made into it — Paddock **refuses to start** if `CLAUDE_CONFIG_DIR` or a
`claudeHome:` key resolves there. That single value is what coupled every concern
on this page together before v0.62, and it also breaks agent memory, because the
harness will not write to a path containing a `.claude` component.

## The `settings.json` special case

This is the one default that is neither "isolated" nor "shared", so it is worth
stating plainly.

`hooks` defaults to `own`, meaning **the shell commands in your
`~/.claude/settings.json` do not run inside Paddock turns**. But that file is a
mixed bag — it carries `hooks` *and* `permissions`, `model`, `statusLine` — and a
symlink is all-or-nothing. So Paddock reads it and:

- if it defines **no hooks**, symlinks it in unchanged;
- if it **does**, writes its own copy into `<data-dir>/claude-home` carrying your
  other keys with `hooks` dropped, regenerated at every startup;
- if it **will not parse**, plants nothing at all, rather than falling back to a
  symlink that would hand over exactly the hooks the key exists to withhold.

A `settings.json` you place in Paddock's own Claude home yourself is never
clobbered: Paddock recognises its own generated file by hash, so editing it makes
it yours.

:::caution[`hooks: own` stops hooks, not every command]
Several other `settings.json` keys also name a script to run — `apiKeyHelper`,
`awsCredentialExport`, `awsAuthRefresh`, `gcpAuthRefresh`, `proxyAuthHelper`,
`otelHeadersHelper`, `statusLine`, `subagentStatusLine` — and they are still
inherited. Several of them are how a corporate login *works*, so dropping them
under a key named `hooks` would break authentication for people who did nothing
wrong. Where they belong is
[#698](https://github.com/edspencer/paddock/issues/698).
:::

## What linking a directory does, and does not, decide

Adding one of your own directories as a project — through
[Discover](/getting-started/#discover-start-from-the-history-you-already-have),
or by hand with a `path:` project — creates **nothing inside it**. No `.paddock/`,
no `.chats/`, no `.gitignore` edit, no `CLAUDE.md`. The project record lives under
`<data-dir>/projects/<slug>/`, the transcripts go in that same place, and the
project holds nothing but the path. The only thing that ever writes into the
directory is the agent you asked to work in it.

Discover also offers the Claude Code sessions it finds **for that directory** for
**adoption**. (The `import-chats` script still calls this *import* — same feature,
one rename behind the UI; [#770](https://github.com/edspencer/paddock/issues/770).)

Linking decides nothing else. In particular it does **not** change where
transcripts live or which login is used — those are `transcripts` and
`credentials`, independently of each other.

:::note[`--here` was removed in 0.68]
Up to 0.67 the flag `paddock --here` opened the current directory as the workspace,
and *that* did write into it: `.paddock/`, `.chats/`, and two `.gitignore` lines.
Nothing does that any more. See [What's New](/whats-new/#068--discover-and---here-is-gone).
:::

**Your originals are never moved or deleted** — that is the invariant, and it holds in
both transcripts modes. Nothing is adopted until you confirm. Note the older phrasing
*"adoption copies, never moves"* was wrong: under `transcripts: host` your `.chats` is a
symlink at your real Claude home, so there is no copy to make. Adopting **lists** a
session that was already there; it does not duplicate it.

## Turning sharing on

Each key is independent, and each takes `own` (Paddock's, isolated) or `host`
(this machine's Claude Code):

```yaml
claude:
  transcripts: own    # own | host — default own
  credentials: host   # own | host — default host
  instructions: own   # own | host — default own
  hooks: own          # own | host — default own
  mcpServers: own     # own | host — default own
```

The two people most often want:

- **`instructions: host`** — load your `~/.claude/CLAUDE.md`, `agents/`,
  `commands/` and `plugins/`. If you keep a curated user-level `CLAUDE.md`, this
  is the key you want; it is off by default and Paddock's notice about that is
  easy to miss (see below).
- **`transcripts: host`** — make a Paddock chat and a `claude --resume` in the
  same directory the same file, live in both directions. Deleting such a chat
  then **releases** it rather than removing it, because the transcript is your
  history rather than Paddock's copy.

Going the other way, **`credentials: own`** is the opt-out from the one default
exception: Paddock will then use only a token in its environment or a login
inside its own Claude home, and a `.credentials.json` symlink planted by an
earlier boot is withdrawn on the next start.

### Plugins are split across two keys

`~/.claude/plugins/` is the one thing in that table governed by **both** levers, because
a plugin is two things at once — mostly instructions (skills, commands, agents, hooks),
plus optionally some MCP servers. So:

| `instructions` | `mcpServers` | What a turn gets |
|---|---|---|
| `host` | `host` | Your plugins, whole — their instructions **and** their MCP servers |
| `host` | `own` | Your plugins' skills/commands/agents/hooks, with their MCP servers skipped |
| `own` | *either* | **No plugins at all**, and a startup notice naming the key that turns them on |

The row that catches people is the last one: **`mcpServers: host` on its own inherits no
plugins.** Enumeration is gated on `instructions`, because withdrawing the `plugins/`
bridge and then passing the plugins anyway — because a different key said `host` — would
contradict a notice Paddock itself prints. If you set `mcpServers: host` expecting your
plugins to arrive, set `instructions: host` too.

One more wrinkle worth knowing before you debug a silent tool denial: a plugin's MCP
server is registered under a **composite** name, not the name it is declared under, so
its allow-list pattern is **`mcp__plugin_<plugin>_<server>__*`**. Paddock derives and
adds that for you. The exception is a plugin whose manifest points `mcpServers` at a
bundle rather than naming servers — Paddock cannot enumerate those, so it attaches the
plugin and prints a boot warning naming the pattern to add by hand. Without the pattern
the server connects and then every call is auto-denied, with no prompt.

## Credentials you hand to Paddock

Separately from the `claude:` block, a sibling
[`mcpServers:` block](/configuration/config-file/#mcpservers--the-servers-this-instance-declares-itself)
declares MCP servers to Paddock itself — and it is the one place you type a
credential into Paddock's own config. Two properties, and one limit:

- **`env:VAR_NAME` is a reference, not a value.** Written anywhere a string goes,
  it is resolved from the environment at startup, so the token stays out of the
  file — which matters, because that file is git-tracked and writable from the
  Config screen. An unset variable drops that one server with a warning naming
  it, rather than starting it without its credential.
- **Nothing Paddock says about the block contains a value from it.** Every
  notice, warning and error routes through one renderer that counts `args` and
  `env` entries rather than printing them, and strips a URL's query, fragment and
  userinfo. There is deliberately no row for the block on the Config screen, so
  it cannot reach an API response either.

:::caution[`driveMode: batch` puts the token on the command line]
This one is downstream of Paddock and cannot be fixed from here. Under
**`driveMode: session`** — the default — the server definitions are handed to
the runtime in-process, and a stdio server receives its `env` the way any
process does: `/proc/<pid>/environ` is owner-only, which is exactly what your
own Claude Code does.

Under **`driveMode: batch`** the engine instead serialises the whole definition
into a `--mcp-config` **argument** to `claude`. Process arguments are not private
on Linux — `/proc/<pid>/cmdline` is world-readable and `ps` prints it — so any
local user can read the token for as long as each turn runs.

So `env:VAR_NAME` keeps a secret out of the file, and on `batch` it does not keep
it out of `ps`. Prefer the default `session` for any server holding a credential.
Paddock warns at startup on `batch`, and mentions it even on `session` — because
a single project pinning `driveMode: batch` for itself brings the exposure back.
That note is written at `info`, so on the `npx` path you will only see it with
`--verbose`.
:::

## Verifying it yourself

Paddock reports what it bridged, what it withheld and which login it found at
startup — but several of those notices are written at `info`, and the `npx`
launcher sets `LOG_LEVEL=warn`. So on the most common install path you will not
see them. Ask explicitly:

```sh
npx @edspencer/paddock --verbose
```

To check the claim rather than the report, look at what is actually in Paddock's
home — under the defaults, the only thing bridged from `~/.claude` is your login:

```sh
ls -l ~/.paddock/claude-home
```

And to confirm nothing of yours is being written to, the transcripts your own
terminal `claude` wrote are untouched under the default `transcripts: own`:

```sh
ls -l ~/.claude/projects
```

## See also

- [Config file — the `claude:` block](/configuration/config-file/#claude--what-this-instance-shares-with-your-claude-code) — every key in depth
- [Environment variables](/configuration/environment/) — the `PADDOCK_CLAUDE_*` overrides
- [What your agents can do](/guides/agent-capabilities/) — the tools a turn can reach
- [Securing Paddock](/guides/securing/) — who can start a turn in the first place
