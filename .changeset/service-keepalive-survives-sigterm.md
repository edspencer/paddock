---
"@paddock/server": patch
---

An installed Paddock service now survives a graceful stop (#872). Both units
relaunched only on a **non-zero** exit (`KeepAlive: SuccessfulExit=false` on
launchd, `Restart=on-failure` on systemd) while the server handles `SIGTERM` by
shutting down cleanly and exiting `0` — so every routine signal (sleep, logout,
a stray `kill`) read as an intended stop and Paddock stayed down until the next
login. A crash was the survivable case. Both units now restart unconditionally.

Upgrading does not rewrite a unit file, so an existing install keeps the old
shape; `paddock service status` now says so and names the fix (re-run
`paddock service install`).
