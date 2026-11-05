---
"@paddock/server": patch
---

CI now runs the CLI contract's `update` conformance checks (`@edspencer/cli-conformance` 0.2): up to date, `--check --json`, no TTY, busy, npx, checkout, a read-only global folder, an update and `--to` a lower version, and, on the real launchd and systemd runners, an update with the service installed and a rollback to exit 6. Nothing about `paddock` itself changes.
