---
"@paddock/server": minor
---

`paddock service install | uninstall | status` — keep Paddock running in the background (#796)

Registers Paddock as a **per-user** background service: a launchd **LaunchAgent** on
macOS (`~/Library/LaunchAgents/net.edspencer.paddock.plist`), a **`systemd --user`** unit
on Linux (`~/.config/systemd/user/paddock.service`). `install` writes the unit and starts
it, `uninstall` stops and removes it, `status` reads real state back out of `launchctl
print` / `systemctl is-active` — including the port the unit was actually installed with.

It starts **at login, not at boot**, and every surface says so. That is not a limitation
to be worked around: on macOS your Claude login is a Keychain item, the login keychain is
unlocked by your account password at login, and a boot-time `LaunchDaemon` has no such
session — so `claude.credentials: host` and boot-time start are mutually exclusive. On
Linux, `install` prints the `loginctl enable-linger` you need to survive logout rather
than running it for you.

The generated unit sets **no** `PADDOCK_DATA_DIR`, so the service and a `paddock` typed
into a terminal are the same `~/.paddock` instance reached two ways; invokes `node`
explicitly by absolute path (launchd's stub `PATH` cannot find the bin's
`#!/usr/bin/env node`); restarts on crash but not on a clean exit; sits in
`<data-dir>/service` rather than `$HOME`; and carries `PATH` and nothing else in its
environment. Installing from an npx cache path is **refused** — those are hash-keyed and
prunable, so the unit would rot silently at some future login.

Also: `paddock start` is now an explicit synonym for the default, and the CLI parses a
leading verb before its flags. Bare `paddock` is unchanged, flags parse the same in every
position, and an unrecognised leading token is still an `unknown option` error.
