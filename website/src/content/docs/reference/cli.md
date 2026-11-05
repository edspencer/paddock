---
title: "CLI reference"
description: "Every paddock command and flag: serve, service, busy, update, doctor and config, with the exit codes and the environment variables the CLI reads."
---

The `paddock` command, all of it. For the why and the walkthroughs, see
[Running as a service](/guides/running-as-a-service/), [Updating](/guides/updating/) and
[Config profiles](/configuration/profiles/); this page is the lookup table.

```bash
npm i -g @edspencer/paddock     # installs `paddock`
npx @edspencer/paddock          # or run it without installing
```

```
paddock [serve] [options]               run the server in this terminal
paddock service <action> [options]      install|uninstall|status|start|stop|restart|logs
paddock busy [--json]                   is the running instance busy?
paddock update [--check] [--to <v>]     install a newer Paddock
paddock doctor [--json] [--offline]     checks, with a fix for each problem
paddock config <show|eject> [options]   what this instance's config resolved to
paddock -v | --version                  print the version and exit
paddock -h | --help                     the full help
```

Every command takes `--help` (`paddock service --help`, `paddock update --help`, …), which
is the same text as this page in more words.

## Conventions

The CLI follows the [CLI contract](https://github.com/edspencer/cli-contract) (SPEC 0.2)
that Ed's local tools share, so these hold for every command:

- **The command comes first, flags after it.** `paddock serve --port 7300` and
  `paddock service install --port 7300` use the same flag grammar.
- **A flag a command can't act on is a usage error (exit 2)**, not something quietly
  ignored: `--force` on `service uninstall`, `--json` on `serve`, `--offline` on anything
  but `doctor`. The message names the commands it does apply to.
- **`--json` prints exactly one JSON document on stdout**, and every word of prose goes
  to stderr. The exit code is the same with or without it.
- **Colour** is on for a terminal and off otherwise. `NO_COLOR` (any non-empty value)
  turns it off; `FORCE_COLOR` turns it on, or off with `0` or `false`.
- **Only `update`, `update --check` and `doctor` contact the npm registry**, and only when
  you run them. Nothing else in the CLI or the server checks for updates.

## `paddock serve`

Runs the server in this terminal until Ctrl-C. **`paddock start` is an alias, kept for
good**, and a bare `paddock` (or `npx @edspencer/paddock`) runs `serve` too.

```bash
paddock serve
paddock serve --port 7300 --open
paddock serve -d ~/paddock-work     # a second, separate instance
```

| Option | What it does |
|---|---|
| `-p, --port <port>` | the HTTP/WS port, 1–65535 (default `7233`, or `$PORT`) |
| `--host <host>` | the bind address (default `127.0.0.1`, or `$HOST`). A routable address needs auth: see [Binding & network exposure](/configuration/binding-and-exposure/) |
| `-d, --data-dir <path>` | the instance: projects, transcripts and state (default `~/.paddock`, or `$PADDOCK_DATA_DIR`) |
| `-o, --open` | open the app in your browser once it is listening |
| `-q, --quiet` | print only the first line, `Paddock <version>: <url>` |
| `--verbose` | show the server's own logs, which are quiet (`warn`) by default |

**The first line on stdout is `Paddock <version>: <url>`**, and nothing comes before it,
so a script can read the URL from it. The server's logs and any first-run notice go to
stderr. The data dir alone decides which instance you get: the directory you run it from
makes no difference. A port that is already in use exits 1, with a suggestion of another.

## `paddock service`

Runs Paddock in the background as a per-user service: a launchd LaunchAgent on macOS, a
`systemd --user` unit on Linux. Not on Windows yet. The full story is
[Running as a service](/guides/running-as-a-service/).

| Command | What it does |
|---|---|
| `paddock service install` | write the unit, enable it, start it, and wait until it answers |
| `paddock service uninstall` | stop it and remove the unit. Your data and logs stay |
| `paddock service start` | start an installed service, and wait until it answers |
| `paddock service stop` | stop it until `service start`, or the next login or boot. It stays installed |
| `paddock service restart` | stop it and start it again, re-reading the unit and config |
| `paddock service status` | installed? running? answering? which version? |
| `paddock service logs` | the last 50 lines of `<data-dir>/logs/service.log` |

| Option | On | What it does |
|---|---|---|
| `-p, --port <port>` | `install` | the port recorded in the unit (default `7233`) |
| `--host <host>` | `install` | the bind address recorded in the unit (default `127.0.0.1`) |
| `-d, --data-dir <path>` | `install` | a data dir *separate* from your terminal's instance. Left out of the unit unless you pass it or `PADDOCK_DATA_DIR` is set |
| `--verbose` | `install` | record the server's own logs, not just warnings |
| `--dry-run` | `install` | print the unit on stdout (and where it would go on stderr), and write nothing |
| `--from-checkout` | `install` | install from a git checkout or `npm link` anyway |
| `--refresh` | `install` | re-write the unit from the settings the installed one records; exit 4 if there is none |
| `--force` | `stop`, `restart` | go ahead even though Paddock is busy |
| `--json` | all but `logs` | one document on stdout: `ok`, `action`, `error` on a failure, and the same fields as `status --json` |
| `-f, --follow` | `logs` | keep printing what gets appended, until Ctrl-C |
| `-n, --lines <n>` | `logs` | how many lines to print first (default 50) |

**Running `install` again keeps the port, host, data dir and verbosity** the installed
unit records, unless a flag gives new ones, and restarts the service onto the new unit.
It refuses, with exit 1, from an npx cache, from a git checkout without
`--from-checkout`, and when something other than Paddock holds the port.

**`stop` and `restart` refuse with exit 75 while Paddock is busy** unless you add
`--force`, which prints the same message prefixed `Overriding:`. `start` and `uninstall`
don't ask. `status --json` reports `installed`, `running`, `answering`,
`installedVersion`, `runningVersion`, `port`, `url`, `pid`, `unit`, `log`, `warnings`, and
`update` when a check has found one.

## `paddock busy`

Asks the running instance whether it is in the middle of something a restart would lose:
a chat turn (a human turn, a fired trigger, a cron fire), a background task a live
session still holds, or a scheduled job. An idle session, an open tab or a pending sweep
is not busy.

```bash
paddock busy                # a sentence, and the exit code
paddock busy --json         # { running, busy, url, version, counts }
```

| Option | What it does |
|---|---|
| `-d, --data-dir <path>` | which instance to ask (default `~/.paddock`, or `$PADDOCK_DATA_DIR`) |
| `--json` | one JSON document on stdout; prose on stderr |

**This command is for its exit code:** 0 not busy, 75 busy, 3 nothing answering, and 1
when something answered but not as Paddock's busy check. It finds the instance through
`<data-dir>/runtime.json` and never guesses a port. 75 is the code Watchtower's
pre-update hook reads as "skip this one"; see
[Docker and Watchtower](/guides/updating/#docker-and-watchtower). Run it from a terminal:
a Paddock chat that runs it counts itself as busy.

The same answer is `GET /api/busy` over HTTP, with no authentication, since it carries
counts and nothing else.

## `paddock update`

Installs a newer Paddock, restarts the service onto it, waits for it to answer, and puts
the old version back if it doesn't. Step by step, and what each failure means, is on
[Updating](/guides/updating/).

```bash
paddock update                  # the latest release, asking first
paddock update --check --json   # what a new version would be; changes nothing
paddock update --to 0.82.1      # a version: the only way to go back
paddock update --to next        # a dist-tag
paddock update --yes            # from a script
```

| Option | What it does |
|---|---|
| `--check` | ask the registry, report, and change nothing. Exits 0 either way; scripts read `updateAvailable` from `--json` |
| `--to <version\|tag>` | a version or dist-tag instead of `latest`. Required to move to a lower version |
| `-y, --yes` | don't ask. Required without a terminal, where `update` otherwise exits 2 |
| `--force` | skip the busy check, and nothing else: the health check and the rollback still run |
| `--json` | one JSON document on stdout; prose on stderr |

An install that isn't Paddock's to replace (Docker, npx, a git checkout, a dependency of
another project, a yarn classic global, a global folder you can't write to, or anything
with `PADDOCK_UPDATE_HINT` set) exits 5 and prints the command that would work. A global
npm, pnpm, bun or volta install updates in place.

## `paddock doctor`

Checks that Paddock can run here, one line each, with a `fix:` under every warning and
failure. Each line starts `✓` (fine), `!` (a warning), `✗` (a failure) or `-` (doesn't
apply here). There's an example on
[Updating](/guides/updating/#checking-an-install-paddock-doctor).

| Option | What it does |
|---|---|
| `--json` | one document on stdout: `{ ok, version, checks: [{ id, status, message, fix? }] }`. The update notice goes to stderr |
| `--offline` | skip the update check, the only one that uses the network |
| `-d, --data-dir <path>` | which instance to check (default: the service's, else `$PADDOCK_DATA_DIR`, else `~/.paddock`) |

| Check | What it looks at |
|---|---|
| `node-engines` | this Node satisfies the package's `engines` (Node 22 or later) |
| `install-method` | how Paddock was installed, and whether `paddock update` can update it |
| `unit` | the service: installed, running and answering, its Node and CLI still there, the same install as this CLI |
| `running-version` | the running Paddock is the installed version |
| `port` | the port is free, or held by Paddock |
| `linger` | on Linux, whether the service keeps running after you log out |
| `data-home` | the data dir is writable |
| `config` | `paddock.config.yaml` and the environment load as `serve` would load them |
| `projects` | the projects folder is writable |
| `claude-login` | a Claude login Paddock can use: which kind, never its value |
| `claude-cli` | a `claude` on `PATH`, which the sweeper always needs, and chats and triggers on `driveMode: batch` |
| `update` | a newer version on the registry (skipped with `--offline`) |

It exits 1 if any check failed; warnings don't count. Apart from the update check's
cache, `<data-dir>/update-check.json`, it writes nothing, and never creates a data dir.

## `paddock config`

What this instance's configuration resolved to, and where each value came from. The
detail is on [Config profiles](/configuration/profiles/#seeing-what-your-profile-actually-resolved-to).

| Command | What it does |
|---|---|
| `paddock config show` | the decisions: your profile, the keys your config file sets, the variables your environment sets |
| `paddock config eject` | preview what freezing the resolution into `paddock.config.yaml` would write. Writes nothing |

| Option | On | What it does |
|---|---|---|
| `-d, --data-dir <path>` | both | which instance to inspect (default `~/.paddock`, or `$PADDOCK_DATA_DIR`) |
| `--resolved` | `show` | every effective value, not just the ones someone set |
| `--json` | `show` | the whole report as JSON, long values in full |
| `--show-sensitive` | `show` | print the values of fields marked sensitive |
| `--write` | `eject` | actually write the file |
| `--include-env` | `eject` | also freeze values an environment variable currently supplies |

## `-v` and `-h`

| Flag | What it does |
|---|---|
| `-v, --version` | print the Paddock version and exit |
| `-h, --help` | print the help and exit. After a command (`paddock doctor --help`), that command's help |

## Exit codes

The codes are the CLI contract's (SPEC §2), and mean the same in every tool that follows
it.

| Code | Meaning | From |
|---|---|---|
| 0 | done; running and answering; up to date; not busy | everything |
| 1 | failed. Also: an install or start that never answered, a refused `service install`, a `doctor` check that failed | everything |
| 2 | usage: an unknown command or flag, a bad value, a flag the command can't act on, or `update` with no terminal and no `--yes`. The usage follows the message | everything |
| 3 | not running: installed but not running or not answering, or nothing answers. From `update`: a foreground `serve` is still answering | `service status`, `busy`, `update` |
| 4 | not installed: there is no service unit | `service status`, `start`, `stop`, `restart`, `logs`, `install --refresh` |
| 5 | this install can't update itself; the right command was printed | `update` |
| 6 | the update failed and was rolled back; the old version is running again | `update` |
| 7 | the update failed and couldn't be rolled back; a person is needed | `update` |
| 75 | busy: refused, and why was printed. Try later, or use `--force` | `busy`, `update`, `service stop`, `restart` |

3 and 4 are the codes `systemctl status` and LSB init scripts use. 75 is `EX_TEMPFAIL`
from `sysexits.h`.

## Environment

What the CLI itself reads. The server reads many more, all on
[Environment variables](/configuration/environment/).

| Variable | Read by | What it does |
|---|---|---|
| `PADDOCK_DATA_DIR` | every command | the data dir when `-d` isn't given (default `~/.paddock`). `service install` records it in the unit if it is set |
| `PORT` | `serve` | the port when `-p` isn't given (default `7233`) |
| `HOST` | `serve` | the bind address when `--host` isn't given (default `127.0.0.1`) |
| `LOG_LEVEL`, `HERDCTL_LOG_LEVEL` | `serve` | left alone if set; otherwise `serve` sets both to `warn` unless `--verbose` |
| `PADDOCK_IN_DOCKER` | `update`, `doctor` | set to `1` by the image: `update` prints the image to pull and exits 5 |
| `PADDOCK_UPDATE_HINT` | `update`, `doctor` | for an install something else manages: `update` prints it and exits 5 |
| `npm_config_registry` | `update`, `doctor` | the registry to ask; else `npm config get registry`, else `https://registry.npmjs.org` |
| `XDG_CONFIG_HOME` | `service` | where the systemd user unit goes (default `~/.config`) |
| `NO_COLOR`, `FORCE_COLOR` | every command | colour off, or forced on (`FORCE_COLOR=0` or `false` forces it off) |

## Files

| Path | What it is |
|---|---|
| `~/.paddock/` | the default data dir: projects, transcripts, state and `paddock.config.yaml` |
| `<data-dir>/runtime.json` | written 0600 while `serve` is listening, removed when it stops: how `busy` and `update` find the instance |
| `<data-dir>/logs/service.log` | the service's log, rotated by Paddock at 8 MB, keeping three older generations |
| `<data-dir>/update-check.json` | what the last `update --check` or `doctor` found, which `service status` repeats |
| `<data-dir>/update.lock` | held while `update` runs, so two updates can't interleave |
| `~/Library/LaunchAgents/net.edspencer.paddock.plist` | the service unit on macOS |
| `~/.config/systemd/user/paddock.service` | the service unit on Linux |
