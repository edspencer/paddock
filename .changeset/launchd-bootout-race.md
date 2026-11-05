---
"@paddock/server": patch
---

`paddock service install`, `start` and `restart` no longer lose a race with launchd

On macOS, `launchctl bootout` returns as soon as launchd has accepted the
request, not once the job has actually gone. `install` and `restart` boot the
label out and immediately bootstrap it back, so they were racing that teardown —
and when they lost, launchd refused the bootstrap with
`Bootstrap failed: 5: Input/output error` and the command exited 1 having
stopped Paddock without starting it again.

It is timing-dependent, which is why it was invisible until it was not: it
passed every time on 0.80.0's pull request and then failed that release's CI on
`paddock service restart`.

Both halves are now in place, because neither is enough on its own. After a
bootout this CLI issued, it polls `launchctl print` until launchd reports the
label gone (up to 10 seconds) before bootstrapping. And a bootstrap that comes
back with one of launchd's two race codes — 5 (`EIO`) or 37 (operation already
in progress), which is what a bootout from a *different* process still in
flight looks like — is retried six times, half a second apart. That second half
is what covers `service start` straight after someone else's `service stop`.

Anything else launchd says — a malformed plist, a domain it cannot find — is
still reported immediately, in launchd's own words, rather than being retried
for three seconds first.
