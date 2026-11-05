---
title: Updating
description: "`paddock update` installs the new version, refreshes the service unit, waits for it to answer — and puts the old version back if it doesn't."
---

```bash
paddock update
```

That is the whole thing. **It asks the registry for the latest version, checks whether
Paddock is busy, asks you to confirm, downloads the new version first (while the old one is
still running), stops the service, installs, starts the new version and waits until it
answers.** If anything from the install on fails, it puts the old version back.

```
Paddock 0.82.0 is available (you have 0.81.0).
  Run: paddock update
  Changes: https://github.com/edspencer/paddock/releases/tag/v0.82.0
```

## Options

| Option | What it does |
|---|---|
| `--check` | **reports and changes nothing. It exits 0 whether or not there's an update; with `--json`, read `updateAvailable`.** |
| `--to <version\|tag>` | **a version or a dist-tag (`next`). It's the only way to move to a lower version.** |
| `--yes`, `-y` | **skips the question. Without a terminal (a script, cron), `--yes` is required, or `update` exits 2.** |
| `--force` | **skips the busy check, and nothing else: the health check and the rollback still run.** |
| `--json` | one JSON document on stdout; prose on stderr |

```bash
paddock update --check --json | jq '.updateAvailable, .target'
paddock update --to 0.81.0     # a version — the only way to go BACK
paddock update --to next       # a dist-tag
paddock update --yes           # from a script
```

`update` never goes backwards by accident: a registry whose `latest` is *older* than what
you have is reported and ignored, and a `latest` that points at a prerelease is not
installed unless `--to` names it.

## Busy

**If Paddock is busy, `update` refuses with exit 75 before anything is stopped**, and says
what's running. Wait, or use `--force`.

```
paddock: Paddock is busy: 2 chat turns are running. Run it from a terminal, not from
    inside a Paddock chat.
```

Busy means a chat turn running, a background task a live session still holds, or a
scheduled job. A chat turn is a live `claude` subprocess writing a transcript, and it
cannot be resumed from where it was interrupted — so a restart loses it.

:::caution[Run it from a terminal, not from inside Paddock]
Paddock's agents can drive Paddock. A chat that runs `paddock update` is itself one of the
things the busy check counts, so it will always see itself as busy — and stopping the
service ends the chat, which then never gets to tell you what happened. This is why the
refusal says where to run it from.
:::

## If the new version doesn't start

**`update` waits up to 30 seconds for the new version to answer. If it doesn't, it prints
the last 20 lines of the log, reinstalls the old version and checks that it answers:
exit 6, "0.82.0 didn't start; 0.81.0 is running again." If the old version doesn't come
back either, it exits 7 and prints the commands to run by hand.**

It waits for `/api/health` to report the version it installed — not merely for the URL to
answer, because the old server, a sibling instance and a supervisor that restarted the old
unit all answer too.

## Without a service

If you run `paddock serve` yourself, there is no service to stop. With nothing running,
`update` installs the new version and you **restart Paddock to use it**. If a foreground
`serve` is answering, `update` asks you to stop it first (Ctrl-C in its terminal) and
exits 3, rather than replacing files under a running server; run it again once it's
stopped.

## Installs that can't update themselves (exit 5)

Paddock works out how it was installed, and some installs aren't its to replace. Those
exit 5 and print the right command instead:

| How it was installed | What it tells you |
|---|---|
| Docker (`PADDOCK_IN_DOCKER=1`, set by the image) | `docker compose pull && docker compose up -d`, with the image tag |
| A managed install (`PADDOCK_UPDATE_HINT` is set) | the hint |
| `npx` / `pnpm dlx` | **`npx @edspencer/paddock@latest` already runs the latest** |
| A git checkout | `git pull && npm install && npm run build` |
| A global folder you can't write to | **the same command with `sudo`. Paddock never runs `sudo` itself.** |
| yarn global, or a dependency of another project | update it the way you installed it |

A global **npm**, **pnpm**, **bun** or **volta** install updates in place.

**A managed install: if `PADDOCK_UPDATE_HINT` is set, `update` prints it and exits 5.** Set
it in the environment of an install something else manages — an Ansible role, a NixOS
module, a deploy job — so nobody updates it by hand:

```bash
docker run -e PADDOCK_UPDATE_HINT='ansible-playbook -i prod paddock.yml' …
```

## Docker and Watchtower

```bash
docker compose pull && docker compose up -d
```

**Nothing installs anything inside a container.** The image sets `PADDOCK_IN_DOCKER=1`,
so `update` there prints the image to pull and exits 5. `paddock` is on `PATH` in the
image, so you can ask a running container:

```bash
docker exec paddock paddock update --check
```

```
Paddock 0.82.0 is available (you have 0.81.0).
  Run: docker compose pull && docker compose up -d    (image ghcr.io/edspencer/paddock:0.82.0)
```

**Watchtower:** enable lifecycle hooks (`WATCHTOWER_LIFECYCLE_HOOKS=true`) and label the
container `com.centurylinklabs.watchtower.lifecycle.pre-update=paddock busy`. **When
Paddock is busy the hook exits 75 and Watchtower skips the update until its next run.**
[Deploying Paddock](/guides/deploying/#keeping-it-current) has the full Compose file, and
the same wait as an Ansible task.

## No automatic checks

**Paddock never checks for updates by itself. Only `update`, `update --check` and `doctor`
ask the registry, and only when you run them. `service status` repeats what the last of
those found.** Not the server, not at startup, not in the background. What the last check
found is cached in `<data-dir>/update-check.json`.

The registry it asks is `npm_config_registry`, else `npm config get registry`, else
`https://registry.npmjs.org`.

## Exit codes

| Code | What happened | What you do |
|---|---|---|
| 0 | Updated, or up to date (or `--check` reported) | nothing |
| 1 | Failed, before anything was stopped | read the message |
| 2 | Usage, or no terminal without `--yes` | fix the command, or add `--yes` |
| 3 | A foreground `serve` is still answering | stop it, then run `update` again |
| 5 | **This install can't update itself; the right command was printed** | run that command |
| 6 | **The update failed and was rolled back; the old version is running again** | read the log it printed, then report it |
| 7 | **The update failed and couldn't be rolled back; a person is needed** | run the commands it printed |
| 75 | **Busy** | wait, or `--force` |

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
12. waits for `/api/health` to report the version it installed;
13. and if any of 10–12 fails, puts the old version back.

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

See also [Running as a service](/guides/running-as-a-service/).
