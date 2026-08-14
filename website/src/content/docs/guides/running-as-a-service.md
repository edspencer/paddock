---
title: Keeping Paddock running on your laptop
description: Register Paddock as a per-user background service with `paddock service install` — a launchd LaunchAgent on macOS, a systemd --user unit on Linux.
---

`npx @edspencer/paddock` is a terminal tab. Close the tab, Paddock stops. That is right
for trying it, and wrong the moment it becomes the thing you use every day — a chat you
want to come back to tomorrow, a schedule you want to fire while you are in a meeting.

```bash
npm i -g @edspencer/paddock
paddock service install
```

That registers Paddock as a **per-user background service** — a launchd **LaunchAgent** on
macOS, a **`systemd --user`** unit on Linux — starts it immediately, and starts it again
each time you log in.

```
paddock service install     register it and start it now
paddock service uninstall   stop it and remove the unit
paddock service status      is it registered, is it running, where are the logs
paddock service start       start an installed service that is stopped
paddock service stop        stop it, and leave it installed
paddock service restart     stop it and start it again, re-reading config
```

Install takes a few seconds and says so as it goes:

```
  Installing the LaunchAgent and starting Paddock…
  macOS may take a few seconds to approve the background item.
  Waiting for http://127.0.0.1:7233 to answer…

  ✓ Paddock is installed as a launchd LaunchAgent, and running at http://127.0.0.1:7233
```

Most of that pause on macOS is the system registering the new LaunchAgent as a login item
— the *"… can run in the background"* notification fires in that window — and it is out of
Paddock's hands. The tick on the last line is not decoration: install **waits for the URL
to answer** before claiming the service is up. If it does not answer within 20 seconds you
get a caveat and a pointer at the logs instead, which is the honest answer when a port
clash has the service restarting in a loop.

## Stopping and restarting

`restart` is the one you will actually reach for — after editing
`paddock.config.yaml`, or to recover a service that stopped. It re-reads the unit on
the way up, and it does not care whether Paddock was running when you asked.

```bash
paddock service restart
```
```
  Restarting Paddock…

  ✓ Paddock is running (pid 41022) at http://127.0.0.1:7233
```

`start` and `restart` **wait for the URL to answer** before printing that line. Neither
launchd nor systemd knows whether the port came up — they know a process was forked, and
they will report a service that is crash-looping on a port clash as `running` for most of
the window between restarts. If the URL does not answer within 20 seconds you get a
caveat and a pointer at the logs instead of a tick.

`stop` is a stop, not an uninstall: the unit stays registered, `status` still finds it,
and it comes back at your next login — or immediately with `paddock service start`.
Use `uninstall` when you want it gone for good.

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
[server story](/guides/deploying/), not this one.

### Linux: you also need lingering

A `systemd --user` manager starts at your first login and stops at your last logout — so
by default the unit dies when you log out, including out of an SSH session. To keep it up:

```bash
loginctl enable-linger $USER
```

`paddock service install` prints this rather than running it: lingering changes how the
machine behaves after you leave it, and needs a privilege the install otherwise never
asks for.

## What gets written

Exactly one file, plus a directory for logs. Nothing else on your machine changes.

| | macOS | Linux |
|---|---|---|
| unit | `~/Library/LaunchAgents/net.edspencer.paddock.plist` | `~/.config/systemd/user/paddock.service` |
| logs | `~/.paddock/service/paddock.log`, `paddock.error.log` | `journalctl --user -u paddock.service -f` |
| working dir | `~/.paddock/service` | `~/.paddock/service` |
| restart | always (`KeepAlive: true`) | always (`Restart=always`) |

Four details in there are deliberate and worth knowing about:

**It restarts unconditionally, not only after a crash.** Both units used to relaunch
Paddock only on a *non-zero* exit, which sounds like the polite choice and is, for a
service, a trap: Paddock handles `SIGTERM` by shutting down cleanly and exiting `0`, so
every routine signal the OS sends — sleep, logout, a stray `kill` — looked like "it meant
to stop", and Paddock stayed down until the next login. A crash was the survivable case.
Unconditional restart does not make the service unstoppable, because neither supervisor
restarts a job it was itself asked to stop: `paddock service uninstall` still puts it
down in one command. Intent belongs in a command, not in an exit code.

:::caution[Installed before this changed?]
Upgrading the package does not rewrite your unit file, so an older install still has the
restart-on-crash-only shape. `paddock service status` says so if yours does. Re-run
`paddock service install` to update it.
:::

**It invokes `node` by absolute path, with the script path after it** — not the `paddock`
bin. The bin is an npm symlink with a `#!/usr/bin/env node` shebang, and launchd hands a
process a stub `PATH` that a version manager's `node` is not on. Exec'ing the bin directly
would fail at login with a bare "no such file or directory".

**It sets no data dir.** With nothing named, the service and a `paddock` typed into a
terminal both fall through to `~/.paddock` — one instance, two ways to reach it. Pass
`--data-dir` at install time only if you actively want the service to be a *different*
instance from your terminal one.

**The environment carries `PATH` and nothing else.** A unit file is a readable file in your
home directory, and the value it would be tempting to put in one is a credential — which is
precisely what the user-agent shape exists to avoid needing.

## Installing from npx: it refuses

```
paddock: `service install` needs an install path that will still be there at your
         next login, and this copy is running from npx's cache — a hash-keyed
         directory that `npm cache clean` removes.

  npm i -g @edspencer/paddock && paddock service install
```

npx materialises the package under `~/.npm/_npx/<hash>/`. Those copies accumulate, and the
whole tree is prunable. A unit pointing in there works right up until it doesn't — at some
future login, unattended. Refusing beats writing a unit we know will rot.

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

Not supported. Windows has no per-user service concept that maps onto either of these
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
