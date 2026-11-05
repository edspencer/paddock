---
"@paddock/server": minor
---

Align the `paddock` CLI with the CLI contract (SPEC 0.1)

`serve` is now the name for running in the foreground, `/api/health` reports the
version it is running, `service status` answers in scriptable exit codes and
`--json`, there is a `service logs`, and the generated units are hardened.

**Behaviour changes a script can see.** These are the reason this release is a
minor rather than a patch:

- **Usage errors now exit `2`, not `1`.** An unknown command, an unknown flag or
  a bad value all exit 2, and print a short usage synopsis after the message. A
  script that tested `$? -eq 1` to detect a typo needs `-eq 2`; `1` now means
  only that something genuinely failed.
- **`service status` now exits `3` or `4`.** `0` when it is installed, running
  and answering; `3` when it is installed but not running — or running and not
  answering, which is the crash-loop a supervisor still reports as `running`;
  `4` when there is no unit at all. Those are the codes `systemctl status` and
  LSB init scripts use. `service logs`, `start`, `stop` and `restart` exit `4`
  with no unit too.
- **An `install`, `start` or `restart` that never answers now exits `1`.** It
  printed the caveat before and exited `0`, so an Ansible task could not tell a
  working install from one that came up dead.
- **Linux service logs go to a file, not the journal.** Both streams append to
  `<data-dir>/logs/service.log` — the same path macOS already used, now one file
  rather than two — which Paddock rotates itself at 8 MB, keeping three
  generations. `journalctl --user -u paddock.service` no longer has anything in
  it. An existing unit keeps the path it names until you re-run
  `paddock service install`, and `status` and `logs` read the path the installed
  unit actually names.

Everything else is additive:

- `paddock serve` runs the server; **`paddock start` remains an alias, for good**
  — every unit installed so far names it, and so do people's scripts.
- `GET /api/health` answers `{ ok, version }`, with no auth, from the same
  version `paddock --version` prints.
- `paddock service status --json` reports installed / running / answering, the
  **installed and running versions**, the port, URL, pid, unit file, log file and
  warnings, as exactly one JSON document on stdout.
- `paddock service logs [-f] [-n <lines>]`, defaulting to the last 50 lines.
- The main `--help` lists all seven `service` actions; it listed three.
- Generated units: Node is resolved through symlinks (an fnm `node` path dies
  with the terminal that installed it), the recorded `PATH` drops per-session
  entries (`fnm_multishells`, `_npx`, `node_modules/.bin`) and directories that
  do not exist, and every `systemd` `ExecStart` word is quoted — a data dir with
  a space in it used to split into the wrong arguments.
- `status` warns when the Node a unit names has gone, and when the running
  version is not the installed one.
- `install` and `status` now **check** lingering (`loginctl show-user`) on Linux
  instead of printing the `enable-linger` line at everyone.
- Real-service CI: `scripts/service-real.mjs` drives the whole lifecycle against
  launchd on a macOS runner and `systemctl --user` on an Ubuntu one.
