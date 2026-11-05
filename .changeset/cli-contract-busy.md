---
"@paddock/server": minor
---

`paddock busy`, `GET /api/busy`, and a `service stop` that refuses when Paddock is mid-turn

Wave C1 of the CLI-contract rollout (edspencer/cli-contract SPEC 0.1, §4).

**New: `paddock busy [--json]`.** Asks the running instance whether it is in the
middle of something a restart would lose. It exits **0** not busy, **75** busy,
**3** when nothing answers, and **1** when something answered but not as
Paddock's busy check. 75 is `EX_TEMPFAIL`, which is also the code Watchtower's
`lifecycle.pre-update` hook reads as "skip this one", so
`com.centurylinklabs.watchtower.lifecycle.pre-update: paddock busy` now makes an
image update wait for a quiet moment.

**`service stop` and `service restart` now run that check first and refuse with
exit 75 unless `--force` is given.** A script that stops Paddock
unconditionally needs `--force`, or needs to handle 75 — that is the behaviour
change in this release. `service uninstall` does not check, and neither does
`service start`. A forced stop prints the same message it would have refused
with, prefixed `Overriding:`.

When the busy work is **chat turns**, the refusal says to run the command from a
terminal rather than from inside a Paddock chat: a chat that asks is itself one
of the turns counted, so `--force` from there stops the service running the
chat, which then has no way to say what happened.

**New: `GET /api/busy`**, answering `{ busy, version, counts }` with counts of
chat turns running (a human turn, a fired trigger, a cron fire), background tasks
a live session is still holding after its turn ended, and herdctl scheduler jobs.
It needs no authentication, because it carries counts and nothing else — no chat
title, session id or project name — and it reads in-memory state only, so it is
cheap enough for a pre-update hook to call in a loop. Not busy: an idle session
(it resumes), an open browser tab (it reconnects), a pending curation sweep (it
re-runs from its watermark).

**New: `<data-dir>/runtime.json`**, written mode 0600 when the server starts
listening and removed when it stops, holding `{ pid, port, url, version,
startedAt }`. It is how the CLI finds the instance without guessing a port; a
file naming a dead pid reads as no instance. Nothing else reads or writes it yet.

**The shutdown path is bounded and says what it cut short.** SIGTERM and SIGINT
are now idempotent (a second signal is a no-op rather than a second concurrent
`app.close()`), remove the runtime file first, log a warning naming how many chat
turns were in flight, and exit within 15 seconds whatever happens — inside
launchd's 20-second kill budget, which `app.close()` waiting on an open
WebSocket could previously overrun.
