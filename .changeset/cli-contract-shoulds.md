---
"@paddock/server": minor
---

**The CLI contract's remaining `service` and `serve` options (SPEC §1, §3).** What a script can see:

- **`paddock service install --dry-run`** prints the unit it would write (the systemd unit or the launchd plist) on stdout, says where it would go on stderr, and writes nothing — not the unit, not a folder. It works with `--refresh` too, and with `--json` (`{ ok, action, dryRun, unit, contents }`).
- **`service install` refuses to run from a git checkout** (or an `npm link`), exit **1**, unless you add **`--from-checkout`**: a unit that runs a working tree follows every rebuild, branch switch and move of it. A global install is unaffected.
- **`service install` refuses a port something else holds**, exit **1**, rather than writing a service that can only crash-loop. A Paddock on the port (a reinstall) is fine, and so is the unit's own running service.
- **`--json` on `service install`, `uninstall`, `start`, `stop` and `restart`**: one document on stdout, `{ ok, action, error?, …the service's status afterwards }` (the same fields as `service status --json`), with every word of prose on stderr. The exit codes don't change; `error` is `busy` for a 75 and `not installed` for a 4.
- **Running `service install` again keeps the installed unit's settings** — its port, host, data dir and verbosity — unless a flag says otherwise (SPEC §1). It used to do that only with `--refresh`, so a plain reinstall over a `--port 9000` service moved it to 7233.
- **`paddock serve --quiet` (`-q`)** prints only the first line, `Paddock <version>: <url>`.
- **Flags belong to their commands:** `--dry-run` and `--from-checkout` (`service install` only), `--quiet` (`serve` only) and **`--json` on a command that has no JSON document — `serve`, `service logs`, `config eject` — now exit 2**. They used to be accepted and ignored.
- A first `service install` that systemd or launchd refuses no longer leaves its unit behind (re-synced with cli-contract's `reference/service/`); a reinstall that fails keeps the unit that was there.
