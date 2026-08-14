---
"@paddock/server": patch
---

`paddock service start | stop | restart` (#873). The service CLI had only
`install | uninstall | status`, so bouncing an installed service meant either
uninstalling it or dropping to the raw supervisor — `launchctl kickstart -k
gui/$(id -u)/net.edspencer.paddock` on macOS, which requires knowing the label
and the domain syntax.

`start` and `restart` wait for the URL to answer before claiming success, so the
"running at <url>" line can no longer sit over a service that is crash-looping
on a port clash — a state both supervisors happily report as running.
