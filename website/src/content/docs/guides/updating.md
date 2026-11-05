---
title: Updating Paddock
description: "`paddock update` installs the new version, refreshes the service unit, waits for it to answer — and puts the old version back if it doesn't."
---

```bash
paddock update
```

That is the whole thing. It asks npm what the latest version is, asks you to confirm,
stops your service, installs, starts it again on the new version, and waits until
`/api/health` reports the version it just installed. If that never happens, it reinstalls
the version you were on and tells you so.

```
Paddock 0.82.0 is available (you have 0.81.0).
  Run: paddock update
  Changes: https://github.com/edspencer/paddock/releases/tag/v0.82.0
```

## Look before you leap

`paddock update --check` asks the registry, prints what it found, and changes nothing. It
exits **0** whether or not there is an update — a script reads `updateAvailable` from the
JSON rather than the exit code:

```bash
paddock update --check --json | jq '.updateAvailable, .target'
```

What it found is cached in `<data-dir>/update-check.json`, and `paddock service status`
repeats it. **Nothing in Paddock contacts the registry on its own** — not the server, not
at startup, not in the background. Only `update`, `update --check` and `doctor` ask, and
only when you run them.

## Updating while something is running

`update` asks the running instance whether it is busy before it stops anything, and
refuses if it is:

```
paddock: Paddock is busy: 2 chat turns are running. Run it from a terminal, not from
    inside a Paddock chat.
```

A chat turn is a live `claude` subprocess writing a transcript, and it cannot be resumed
from where it was interrupted — so a restart loses it. Wait, or override the check with
`--force`. `--force` skips **only** that check: the health check and the rollback still run.

:::caution[Run it from a terminal, not from a chat]
Paddock's agents can drive Paddock. A keeper chat that runs `paddock update` is itself one
of the chat turns the busy check counts, so it will always see itself as busy — and
`--force` from there stops the service that is running the chat, which then never gets to
tell you what happened. This is why the refusal says where to run it from.
:::

## Going somewhere particular

```bash
paddock update --to 0.81.0     # a version — the only way to go BACK
paddock update --to next       # a dist-tag
```

`update` never goes backwards by accident: a registry whose `latest` is *older* than what
you have is reported and ignored, and a `latest` that points at a prerelease is not
installed unless `--to` names it.

## Without a terminal

`update` asks a question, and a question needs a terminal. In a script, a cron job or an
Ansible task there is none, so it exits **2** and says `--yes` is required rather than
guessing:

```bash
paddock update --yes
```

## When it goes wrong

The exit code is the whole report, and the two failure codes mean different things:

| Code | What happened | What you do |
|---|---|---|
| 0 | Updated, or already up to date | nothing |
| 2 | No terminal to ask, so `--yes` is required | add `--yes` |
| 5 | This install can't update itself — the right command was printed | run that command |
| 6 | The new version didn't start. **The old one is running again** | read the log it printed, then report it |
| 7 | The new version didn't start **and the old one could not be restored** | run the commands it printed |
| 75 | Busy | wait, or `--force` |

On a rollback, `update` prints the last 20 lines of the service log before it puts the old
version back — which is usually enough to see why the new one did not come up.

## Installs that can't update themselves (exit 5)

Paddock works out where it is running from, and five layouts are not its to replace. Each
prints the command that *would* work:

| Where it is running from | What it tells you |
|---|---|
| A container image | `docker compose pull && docker compose up -d` |
| A managed install (`PADDOCK_UPDATE_HINT` is set) | whatever that variable says |
| `npx` / `pnpm dlx` | `npx @edspencer/paddock@latest` — npx already runs the latest each time |
| A checkout | `git pull && npm install && npm run build` |
| A dependency of another project | update it in that project |

A global **npm**, **pnpm**, **bun** or **volta** install updates in place.

If the global folder is not writable, `update` prints the same command with `sudo` and
exits 5. **It never runs `sudo` itself** — that is a decision for the person at the
keyboard, not for a tool that has just decided to replace its own files.

## In Docker

Nothing installs anything inside a container. The image sets `PADDOCK_IN_DOCKER=1`, so
`update` there prints the image to pull and exits 5:

```bash
docker exec paddock paddock update --check
```

```
Paddock 0.82.0 is available (you have 0.81.0).
  Run: docker compose pull && docker compose up -d    (image ghcr.io/edspencer/paddock:0.82.0)
```

`paddock` is on `PATH` in the image, so `docker exec paddock paddock busy` works too —
which is what lets an automatic updater wait for a quiet moment. See
[Deploying Paddock](/guides/deploying/#keeping-it-current).

If something else manages the container — Ansible, a Helm chart, a deploy job — set
`PADDOCK_UPDATE_HINT` to the command that actually upgrades it, and `update` prints that
instead of guessing:

```bash
docker run -e PADDOCK_UPDATE_HINT='ansible-playbook -i prod paddock.yml' …
```

## What it does, step by step

Worth knowing if you are automating around it, or if it stops half way:

1. takes `<data-dir>/update.lock`, so two updates cannot interleave;
2. works out how this copy was installed;
3. asks the registry for the target version and its `engines.node`;
4. compares — and stops here with `--check`;
5. checks the global folder is writable;
6. asks the running instance whether it is **busy**, before anything is stopped;
7. asks you, unless `--yes`;
8. fetches **both** the new and the current version into the npm cache, while the old
   version is still serving, so a rollback has its package to hand even if the network
   has gone;
9. stops the service;
10. installs with the package manager this copy came from;
11. hands over to the **new** CLI, which re-writes the service unit in its own format
    with the port and data dir the old one recorded (`paddock service install --refresh`);
12. waits for `/api/health` to report the version it installed — not merely for the URL
    to answer, because the old server, a sibling instance and a supervisor that restarted
    the old unit all answer too;
13. and if any of 10–12 fails, puts the old version back.

The registry it asks is `npm_config_registry`, else `npm config get registry`, else
`https://registry.npmjs.org`.

## Checking an install: `paddock doctor`

`paddock doctor` runs every check an update depends on, and a few Paddock needs to work at
all, one line each, with a `fix:` under anything that's wrong:

```
✓ Node 22.23.4 (Paddock needs >=22)
✓ Paddock 0.82.1, installed globally with npm: `paddock update` can update it
! the service is installed (systemd) but not running
    fix: paddock service start    (and `paddock service logs` if it doesn't stay up)
- Paddock isn't running
✓ port 7233 is free
! linger is off for ed: the service stops when you log out, and starts only when you log in
    fix: sudo loginctl enable-linger ed    (Paddock never runs sudo itself)
✓ the data dir ~/.paddock is writable
✓ the config loads
✓ the projects folder ~/.paddock/projects is writable
✓ Paddock shares this machine's Claude Code login (~/.claude, claude.credentials: host)
✓ claude is on PATH (/usr/local/bin/claude)
! Paddock 0.83.0 is available (you have 0.82.1)
    fix: paddock update
```

`✓` is fine, `!` a warning, `✗` a failure, and `-` a check that doesn't apply here. It
exits **1** if anything failed; warnings don't change the exit code. The checks are the
ones every tool built on the same CLI contract runs (`node-engines`, `install-method`,
`unit`, `running-version`, `port`, `linger`, `data-home`, `update`), then Paddock's own:
`config`, `projects`, `claude-login` (which *kind* of login it found, never the login
itself) and `claude-cli`.

`--json` prints the same checks as one document, for a script; `--offline` skips the
update check, the only one that leaves the machine. Like `update --check`, that check
writes what it found to `<data-dir>/update-check.json`, so `paddock service status`
repeats it.

## Updating by hand

There is nothing magic about `update` — it runs the commands you would:

```bash
paddock busy                      # 0 not busy, 75 busy, 3 nothing running
paddock service stop
npm install -g @edspencer/paddock@latest
paddock service install --refresh  # re-write the unit, keeping its settings
paddock service status
```

`service install --refresh` is the one worth remembering: it re-renders the unit from
what the **existing** one records, rather than from the flags and environment of the shell
you happen to be in. With nothing installed it exits 4 rather than quietly performing a
first install with defaults.
