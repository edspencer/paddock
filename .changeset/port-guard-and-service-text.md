---
"@paddock/server": patch
---

fix(cli): reject a non-numeric `--port`, and make `paddock service` report one instance

**`paddock --port start` was accepted and the server listened on `NaN` (#823).**
`--port` took any string — `next()` only rejects a missing value — so the typo
travelled three files before becoming `Number("start")` in the config resolver,
with nothing between the mistake and a server asked to bind `NaN`. It is now a
value error at the point of parsing: `--port needs a number between 1 and 65535`.

An empty value is still accepted as "unset", deliberately: `paddock --port
"$PORT"` with `PORT` unset passes `""`, which is falsy where it is read and
correctly falls through to the default. A stricter guard would have turned a
working invocation into a hard error.

**`paddock service` printed two different journalctl commands (#824).** The help
text and the running-as-a-service guide said `-u paddock`; `install` and
`status` printed `-u paddock.service`. Both work — systemd appends the implicit
suffix — but a user who copies one and then sees the other has to stop and work
out whether the difference matters. All three now say `paddock.service`, which
is what the tool actually prints and stays correct if the unit is renamed.

**`paddock service status --data-dir X` mixed two instances into one report.**
That block reports the INSTALLED unit, but `--data-dir` (documented as
install-only) still reached the log-path spec, so the printed `Data:` came from
the unit while `Logs:` pointed under today's flag — a directory the service
never writes to, and on macOS a real file path rather than journald. `status`
now ignores the flag; `install`, which legitimately needs it to win, is
unchanged.

**`GET /api/discover`'s published description said `excluded` counts folders
(#821).** It counts directories, and the implementation dedupes on purpose to
make it so. The description now states both units and the one per-folder
exception, since the trap is that `scanned` and `excluded` do not reconcile by
subtraction.
