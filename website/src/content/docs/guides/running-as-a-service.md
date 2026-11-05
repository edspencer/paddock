---
title: Running as a service
description: "`paddock service install` sets Paddock up to start when you log in and to restart if it stops: a LaunchAgent on macOS, a systemd user service on Linux."
---

`npx @edspencer/paddock` is a terminal tab. Close the tab, Paddock stops. That is right
for trying it, and wrong the moment it becomes the thing you use every day — a chat you
want to come back to tomorrow, a schedule you want to fire while you are in a meeting.

```bash
npm i -g @edspencer/paddock
paddock service install
```

`paddock service install` sets Paddock up to **start when you log in and to restart if it
stops**: a launchd **LaunchAgent** on macOS, a **systemd user service** on Linux. It starts
it straight away too. **Windows isn't supported yet.**

To move to a new version, use [`paddock update`](/guides/updating/) — it stops the
service, installs, re-writes the unit with the settings this one records, waits for the
new version to answer, and puts the old one back if it doesn't.

## Installing

```bash
paddock service install                     # 127.0.0.1:7233, data in ~/.paddock
paddock service install --port 7300         # another port
paddock service install --dry-run           # print the unit; write nothing
```

| Option | What it does |
|---|---|
| `-p, --port <port>` | the port (default 7233) |
| `--host <host>` | the bind address (default `127.0.0.1`) |
| `-d, --data-dir <path>` | a data dir *separate* from your terminal's instance — see below |
| `--verbose` | record the server's own logs, not just warnings |
| `--dry-run` | print the unit it would write, and write nothing |
| `--from-checkout` | install from a git checkout anyway |
| `--refresh` | re-write the unit from the settings the installed one records |
| `--json` | one JSON document on stdout; prose on stderr |

**It waits until Paddock answers** before it returns:

```
  Installing the LaunchAgent and starting Paddock…
  macOS may take a few seconds to approve the background item.
  Waiting for http://127.0.0.1:7233 to answer…

  ✓ Paddock is installed as a launchd LaunchAgent, and running at http://127.0.0.1:7233
```

The tick on the last line is not decoration. If Paddock does not answer within 20 seconds
you get a caveat and a pointer at the logs instead, and the exit code is **1** — which is
the honest answer when a port clash has the service restarting in a loop. Most of the
pause on macOS is the system registering the new LaunchAgent as a login item (the
*"… can run in the background"* notification fires in that window), and it is out of
Paddock's hands.

**Running it again is safe:** it keeps the port and settings the service already has —
its port, host, data dir and verbosity — unless you give new ones, and restarts the
running service onto them. `--refresh` does the same and never takes the data dir from
`PADDOCK_DATA_DIR` in your shell; with nothing installed it exits 4 rather than doing a
first install with defaults. It is what `paddock update` runs.

**`--dry-run` prints the unit and writes nothing** — not the unit, not a folder. The unit
goes to stdout and the line saying where it would go to stderr, so
`paddock service install --dry-run > paddock.service` captures the unit alone.

It **refuses** to install, with exit 1:

- **from an npx cache** — the folder is temporary (see below);
- **from a git checkout, unless you add `--from-checkout`** — a unit that runs a working
  tree follows every rebuild, branch switch and move of it, at your next login;
- **when something else holds the port** — the service could only crash-loop. A Paddock
  on the port is fine: that's the reinstall replacing it.

### Linux: linger

A systemd user manager starts at your first login and stops at your last logout — so
**without linger, the service stops when you log out**, including out of an SSH session.
`install` and [`doctor`](/guides/updating/#checking-an-install-paddock-doctor) check
(`loginctl show-user $USER -p Linger`) and, if it's off, print:

```bash
sudo loginctl enable-linger $USER
```

**Paddock never runs `sudo` itself**: lingering changes how the machine behaves after you
leave it, and needs a privilege the install otherwise never asks for. If linger is already
on, they say nothing; where the check cannot answer at all (a container with no
`loginctl`), they say nothing either.

## Where things are

| | macOS | Linux |
|---|---|---|
| unit | `~/Library/LaunchAgents/net.edspencer.paddock.plist` | `~/.config/systemd/user/paddock.service` |
| log | `~/.paddock/logs/service.log` | `~/.paddock/logs/service.log` |
| working dir | `~/.paddock/service` | `~/.paddock/service` |
| restart | always (`KeepAlive: true`) | always (`Restart=always`) |

The unit runs **this Node and this install's `cli.js` by their real paths**, never the
`paddock` shim — so **if you remove that Node version (nvm, fnm, volta), `service status`
and `doctor` warn, and `service install` again fixes it**. The symptom without the warning
is Paddock absent one morning with an *empty* log, because it never got as far as running.

A few more details are deliberate:

**It restarts unconditionally, not only after a crash.** Paddock handles `SIGTERM` by
shutting down cleanly and exiting `0`, so a unit that relaunched only on a *non-zero* exit
stayed down after every routine signal — sleep, logout, a stray `kill` — until the next
login. Neither supervisor restarts a job it was itself asked to stop, so `service stop` and
`service uninstall` still put it down.

:::caution[Installed before this changed?]
Upgrading the package does not rewrite your unit file, so an older install may still have
the restart-on-crash-only shape. `paddock service status` says so if yours does. Re-run
`paddock service install` to update it.
:::

**The `PATH` it records is rebuilt, not inherited.** Node's own bin directory first,
then whatever of the installing shell's `PATH` is worth keeping, then the system
directories — dropping the entries that belong to one shell session or one npm
invocation (`fnm_multishells`, `_npx`, `node_modules/.bin`) and any directory that
does not exist.

**It sets no data dir.** With nothing named, the service and a `paddock` typed into a
terminal both fall through to `~/.paddock` — one instance, two ways to reach it. Pass
`--data-dir` at install time only if you want the service to be a *different* instance.

**The environment carries `PATH` and nothing else.** A unit file is a readable file in your
home directory, and the value it would be tempting to put in one is a credential.

## The commands

| Command | What it does |
|---|---|
| `paddock service install` | write the unit, enable it, start it, and wait until it answers |
| `paddock service uninstall` | **stop it and remove the unit. Your data and logs stay.** |
| `paddock service start` | start the installed service, and wait until it answers |
| `paddock service stop` | **stop it until `service start`, or the next login or boot** |
| `paddock service restart` | stop it and start it again, re-reading the unit and config |
| `paddock service status [--json]` | installed? running? answering? which version? |
| `paddock service logs [-f] [-n <lines>]` | **the last 50 lines; `-f` follows, `-n` sets how many** |

`stop` **doesn't disable the service. To keep it off for good, use `service uninstall`.**
That is the service managers' own convention: `systemctl --user stop` and a launchd
`bootout` both leave the unit to come back at the next login.

`start` clears a failed state first on Linux (`systemctl --user reset-failed`): a unit that
hit systemd's limit of five starts in ten seconds stays failed, with nothing in the log
about why, until something does.

`install`, `uninstall`, `start`, `stop` and `restart` take **`--json`** too: one document on
stdout — `ok`, `action`, an `error` when it failed, and the same fields as
`status --json`, as they are afterwards — and every word of prose on stderr.

### Asking it how it is

`status` answers in prose and in **exit codes**, which is what makes it scriptable (see
[Exit codes](#exit-codes)). "Not answering" counts as not running on purpose: both
supervisors report a service that is crash-looping on a port clash as `running` for most
of the window between restarts.

`--json` carries the same report as one document on stdout, with the **installed** and
**running** versions in it:

```bash
paddock service status --json
```
```json
{
  "installed": true,
  "running": true,
  "answering": true,
  "installedVersion": "0.80.0",
  "runningVersion": "0.79.1",
  "port": 7233,
  "url": "http://127.0.0.1:7233",
  "pid": 41022,
  "unit": "/Users/ed/Library/LaunchAgents/net.edspencer.paddock.plist",
  "log": "/Users/ed/.paddock/logs/service.log",
  "warnings": ["It is running 0.79.1, but 0.80.0 is installed. …"]
}
```

Two versions, because they can differ and the difference is invisible otherwise: that is
an instance upgraded with `npm i -g` under a service that has not restarted.
`paddock service restart` is the fix, and `status` says so.

For everything around the service as well — the Node it runs, the port, linger, the data
dir, your Claude login, a newer version — run `paddock doctor`
([Checking an install](/guides/updating/#checking-an-install-paddock-doctor)).

## Busy

**`service stop` and `service restart` first ask the running Paddock whether it's busy** —
a chat turn running, a background task a live session still holds, or a scheduled job.
**If it is, they refuse with exit 75 and say what's running. Wait and try again, or add
`--force`, which prints the same message prefixed `Overriding:` and goes ahead.**

```
paddock: Paddock is busy: 1 chat turn is running. Run it from a terminal, not from inside
    a Paddock chat.
```

Being refused is the useful case: a restart kills a chat turn mid-sentence, and the turn
cannot be resumed from where it was. `uninstall` doesn't ask — removing the service is an
explicit act — and neither does `start`, which has nothing to cut short.

`paddock busy` asks the same question on its own: **0** not busy, **75** busy, **3**
nothing running.

:::caution[Run it from a terminal, not from a chat]
Paddock's agents can drive Paddock. A chat that runs `paddock service restart` is itself one
of the chat turns the busy check counts, so it always sees itself as busy — and `--force`
from there stops the service running that chat, which then never gets to say so.
:::

## Logs

```bash
paddock service logs          # the last 50 lines
paddock service logs -n 200   # more of them
paddock service logs -f       # and keep printing
```

One file, `~/.paddock/logs/service.log`, which stdout and stderr both append to, on every
OS. **Paddock rotates it itself** (by copying and truncating, at 8 MB, keeping three
older generations, `service.log.1` … `.3`), because the service manager holds it open —
and nothing else would: a systemd user unit writing to a file gets no journal rotation,
and macOS has never had anything that would.

Linux used to send this to the journal. It does not any more: `journalctl --user` shows
*nothing* on a distribution whose journal is volatile — which is exactly the reboot you are
asking about — and one file means one answer to "where are the logs" everywhere.

`uninstall` keeps the logs. The last thing anyone wants from an uninstall is for the record
of *why* they are uninstalling to vanish with it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | running and answering (`status`), or done |
| 1 | failed — including an install or start that never answered, and the refusals above |
| 2 | usage: an unknown action or flag, or a bad value |
| 3 | **installed but not running or not answering** |
| 4 | **not installed**: there is no unit (`status`, `start`, `stop`, `restart`, `logs`) |
| 75 | **busy**: `stop` or `restart` refused, and why was printed. Wait, or `--force` |

Codes 3 and 4 are the numbers `systemctl status` and LSB init scripts already use, so an
Ansible task or a shell `if` written against either keeps working.

## At login, not at boot

**This is the one thing to know before you install it.** Paddock starts when you *log in*,
not when the machine boots. Restart your Mac and walk away, and Paddock is not running
until somebody logs in.

That is not an oversight, and it is not fixable by switching to a system daemon. It falls
out of how your Claude login works:

- On macOS, your Claude Code login is a **Keychain item**. The login keychain is unlocked
  by your account password *at login*. A LaunchAgent runs inside that session, as you, so
  it can read the item. A `LaunchDaemon` starts at boot with no user session — nothing has
  supplied the password, the keychain is locked, and `UserName` in the plist does not help
  because it changes the effective uid rather than the keychain's unlock state.
- So on darwin, **`claude.credentials: host` and boot-time start are mutually exclusive.**

A boot-time instance is a different thing, and you can have it — but the price is
explicit: a system-level unit with `claude.credentials: own` and a long-lived
`CLAUDE_CODE_OAUTH_TOKEN` sitting in its environment. That is the
[server story](/guides/deploying/), not this one. (On Linux, linger is what lets a user
service start at boot: see [above](#linux-linger).)

## Installing from npx: it refuses

```
paddock: `service install` needs an install path that will still be there at your
         next login, and this copy is running from npx's cache — a hash-keyed
         directory that `npm cache clean` removes.

  npm i -g @edspencer/paddock && paddock service install
```

npx materialises the package under `~/.npm/_npx/<hash>/`. Those copies accumulate, and the
whole tree is prunable. A unit pointing in there works right up until it doesn't — at some
future login, unattended. A git checkout is refused for the same kind of reason, and
`--from-checkout` is there for working on Paddock itself.

## Access, once it is always on

Paddock binds loopback with authentication off, and that stays true here. A service is up
for as long as you are logged in rather than for as long as a terminal tab — so the window
is longer, but it is **not wider**: any local process that could reach `127.0.0.1:7233`
could already read the same Claude login, as the same user. The daemon changes duration,
not reach.

The case that is genuinely worth thinking about is a web page in your browser poking at
localhost, and that applies equally to an `npx` run today. If you want a credential on the
port anyway, set `PADDOCK_AUTH_MODE` — see [Authentication](/configuration/authentication/).
The [bind-safety guard](/configuration/binding-and-exposure/) still refuses to bind a
routable interface with auth off, service or not.

## Known unverified

`launchctl kickstart` while logged in is tested on real hardware: a turn completed against
a Keychain-only Claude login, with no credential in the process environment and no
permission dialog.

**Start at login itself — `RunAtLoad`, after a genuine logout or reboot — has not been
tested.** If a login-time agent can start before the login keychain is usable, the symptom
would be turns failing with `Not logged in` after a reboot, recovering after a
`paddock service uninstall && paddock service install`. Please report it if you see it:
the fix belongs in the generated plist.

## Windows

Not supported yet. Windows has no per-user service concept that maps onto either of these
without a scheduled task or a service wrapper, and shipping an untested third writer would
be worse than saying so. `paddock service` tells you as much rather than guessing.

## This is not the server story

Paddock under systemd on a server is a **different** setup and documented separately —
[Deploying Paddock](/guides/deploying/) and
[Running Paddock on Proxmox (LXC)](/guides/proxmox-lxc/) Path B. The differences are not
cosmetic:

| | server | laptop (this page) |
|---|---|---|
| scope | system unit, service user | user agent, runs as you |
| credentials | token in the unit's environment | your own Claude login |
| exposure | behind auth at a reverse proxy | loopback only |
| provisioning | Ansible, infra-as-code | one command |

## Next

[Updating](/guides/updating/): `paddock update`, and what it does when the new version
doesn't start.
