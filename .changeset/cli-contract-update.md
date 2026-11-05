---
"@paddock/server": minor
---

**`paddock update` — install a newer Paddock, and put the old one back if it doesn't start.** The whole of the CLI contract's §5 sequence: a lock so two updates cannot interleave, install detection against §6's ten layouts, the npm registry over `fetch`, a writability check with a `sudo` hint it prints and never runs, the busy check **before anything is stopped**, the question, `npm cache add` for both versions while the old one is still serving, then stop → install → hand over to the new CLI → wait for `/api/health` to report the version it installed. `upgrade` is accepted as a hidden alias.

```
paddock update                      update to the latest release, asking first
paddock update --check [--json]     what a new version would be; changes nothing
paddock update --to 0.79.1          a version — the only way to go BACK
paddock update --to next            a dist-tag
paddock update --yes                do not ask (required with no terminal)
paddock update --force              skip the busy check, and nothing else
```

**What a script can see, and what changed:**

- **New exit codes are now reachable.** `5` this install cannot update itself (Docker, a managed install, npx, a checkout, a project dependency, yarn classic, or a global folder that is not writable) — the command that *would* work is printed. `6` the new version did not start and the old one is running again. `7` the new version did not start and the old one could not be restored; the commands to run by hand are printed. `75` busy.
- **`update` without a terminal exits 2** unless `--yes` is given, rather than guessing.
- **`service install --refresh` is new**, and re-renders an existing unit from the settings *it* records — its port, host, data dir and verbosity — rather than from the invoking shell's flags and environment. With nothing installed it exits **4**. This is what `update` runs, through the new version's CLI.
- **`service install` now restarts the unit as well as enabling it, on Linux.** `systemctl --user enable --now` does nothing to a unit that is already active, so a reinstall over a running service wrote a new unit and left the old process serving — which is the state a rollback is in. A reinstall is now a real reinstall.
- **`service status` reports an update**, from `<data-dir>/update-check.json`, which `update --check` writes. The prose goes to stderr; `--json` carries it as `update: { latest, updateAvailable, checkedAt }`. **Nothing contacts the registry on its own** — not the server, not at startup, not in the background. Only `update`, `update --check` and `doctor` ask, and only when a person runs them.
- **The image sets `PADDOCK_IN_DOCKER=1` and puts `paddock` on `PATH`.** `docker exec <container> paddock update --check` prints the image to pull; `docker exec <container> paddock busy` is what lets Watchtower's pre-update hook wait for a quiet moment. `PADDOCK_UPDATE_HINT` replaces the printed command for an install something else manages.
- **`--force`, `--check`, `--to`, `--yes` and `--refresh` are rejected with exit 2 on commands that cannot act on them**, rather than parsed and silently dropped.
