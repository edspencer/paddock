---
"paddock": patch
---

`paddock update` and `paddock service` now run on the copies from edspencer/cli-contract `reference/` @ 0.2. What you can see:

- **The update notice goes to stderr** (SPEC §3), on `update --check` and when an install can't update itself, as it already did under `--json`. A script reading stdout for "is available" should read `update --check --json`'s `updateAvailable`.
- **npm is run as `node <npm-cli.js>`**, the npm beside the Node running `paddock`, never through a shell or the PATH's `npm`.
- **`update` waits for the old version to stop answering** before installing (SPEC §5 step 9), and **`service stop` on macOS waits for launchd to finish the bootout**, so a `start` straight after it doesn't race it.
- **`service start` and `restart` clear systemd's failed state first**, so a unit that hit the start limit comes back.
- `service status` no longer repeats an update check written by another version than the one installed, and a prerelease on `latest` isn't cached as available.
- Some messages are worded differently (`couldn't reach the registry`, `there's no terminal to ask, so --yes is needed`). Exit codes are unchanged.
