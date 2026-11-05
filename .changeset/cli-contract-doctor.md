---
"@paddock/server": minor
---

**`paddock doctor [--json] [--offline]` — check that Paddock can run here, with a fix for each problem.** The `--help` and the updating guide already named it; now it exists. One line per check, starting `✓`, `!` (a warning), `✗` (a failure) or `-` (doesn't apply here), with a `fix:` line under every warning and failure.

- **The CLI contract's eight checks**, with the ids every tool uses: `node-engines`, `install-method`, `unit` (installed, running and answering; its Node and CLI still there; the same install as this CLI), `running-version`, `port` (free, or held by Paddock), `linger` (Linux), `data-home` and `update`. Then Paddock's own: `config` (the config loads as `serve` would load it), `projects` (the projects folder is writable), `claude-login` (which kind of Claude login it would use — never the login itself) and `claude-cli` (a `claude` on PATH, which the sweeper always needs and `driveMode: batch` needs for every turn).
- **What a script can see:** exit **1** if any check failed, **0** otherwise (warnings don't count), **2** for a usage error. `--json` prints one document on stdout, `{ ok, version, checks: [{ id, status, message, fix? }] }`, matching the contract's `schemas/doctor.schema.json`; the update notice goes to stderr.
- **The update check asks the npm registry** — only because you ran it — and writes `<data-dir>/update-check.json` the way `update --check` does, so `service status` repeats it — into a data dir that's already there only, so `doctor` never creates an instance. An unreachable registry is a warning, not a failure. `--offline` skips it. `doctor` writes nothing else.
- **`--offline` is a usage error (exit 2) on every other command**, like `--force`, `--check` and `--refresh`.
