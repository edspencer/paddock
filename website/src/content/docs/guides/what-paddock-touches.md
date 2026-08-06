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
| `~/.claude/projects/` (your transcripts) | not read, not written | [`transcripts`](/configuration/config-file/#transcripts) |
| `~/.claude.json` (your MCP servers) | not opened | [`mcpServers`](/configuration/config-file/#mcpservers) |
| Anything else in `$HOME` | not touched | — |
| The directory you ran `paddock` in | not touched, unless you pass `--here` | — |

**Nothing in that table is written to by default.** The only write Paddock ever
makes outside its data directory is under `transcripts: host`, where it creates
(`mkdir -p`) the encoded project folder under `~/.claude/projects/` — a directory
Claude Code itself would create the first time you ran `claude` there.

## Where Paddock's own state lives

Everything else is in one directory — `~/.paddock` unless you pass `--data-dir`,
or `<dir>/.paddock` under `--here`. Move it to move the instance; delete it to
start over.

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

## What `--here` does, and does not, decide

`paddock --here` opens the current directory as the workspace. It creates
`.paddock/` and `.chats/` there and adds both to `.gitignore`, and it offers any
Claude Code sessions you already have **for that directory** for import.

It decides nothing else. In particular it does **not** change where transcripts
live or which login is used — those are `transcripts` and `credentials`,
independently of the flag and of each other. (In 0.61.1 the flag did decide both;
that is why it was removed as a lever.)

Import **copies**, never moves: your own history stays where it is, and nothing
is imported until you confirm.

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
