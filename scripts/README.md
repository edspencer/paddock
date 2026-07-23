# `scripts/`

Standalone helper scripts used to develop, test, and package Paddock. They are
not part of the app build (the `packages/*` workspaces are) — most are `.mjs`
(ESM) or `.sh`; the extensionless `pm` is a CommonJS Node script, which is why
this directory carries its own `package.json` (`"type": "commonjs"`) so it does
not inherit the repo root's `"type": "module"`.

## `pm` — stable-port preview servers for agents

`pm` is a thin wrapper over [PM2](https://pm2.keymetrics.io/) plus a small shared
ports registry. It exists so a coding agent (or a person) can run long-running
dev/preview servers on **stable, assigned ports**, with running-state visible to
**every** session: PM2's daemon and the ports registry (`ports.json`) are a
single shared source of truth that all callers read.

Each named project gets a stable port (default range `5001–5999`), and `pm`
injects `PORT` and `HOST=0.0.0.0` into the process so a framework that honours
those (`next dev`, Vite, etc.) binds correctly without hard-coding a port. `pm`
then prints the preview URL.

The **devbox image** bundles `pm` (installed to `/usr/local/bin/pm`, with PM2
installed globally) so the preview-server workflow is turnkey there. On a bare
checkout you can run it directly: `./scripts/pm help` (PM2 must be on `PATH` for
the process-management commands).

### Commands

```
pm start <project> [--cwd DIR] [--host HOST] [-- <cmd...>]
                           Assign/look up the project's stable port, inject
                           PORT + HOST=0.0.0.0, and start <cmd> under PM2.
                           A later `pm start` with no `-- cmd` reuses the
                           previously-recorded command.
pm stop <project>          Stop the process (keeps its assigned port).
pm restart <project>       Restart with a freshly-rebuilt env.
pm rm <project>            Stop and forget (drops it from PM2 + the registry).
pm status [project] [--json]
                           Join `pm2 jlist` + the registry → project · port ·
                           state · URL.
pm logs <project> [--lines N] [--follow]
pm ports                   Print the raw ports registry.
pm help
```

Example:

```
pm start web --cwd /path/to/app -- npm run dev
pm status
# PROJECT   PORT   STATE    URL
# web       5001   online   http://localhost:5001
```

### Config knobs

Resolution order for each knob: **real environment variable → config file →
built-in default**. The config file lets `pm` show correct values even when the
caller's env carries no `PM_*` vars (e.g. an agent invoking `pm` via a
non-login shell that sources no profile). `pm` is a fresh process per call and
reads the file at invocation time, so updating it needs no restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PM_PUBLIC_HOST` | `localhost` | Host shown in the printed preview URLs. Set it to the hostname/domain your instance is reachable at. |
| `PM_PORT_MIN` | `5001` | Low end of the port-assignment range. |
| `PM_PORT_MAX` | `5999` | High end of the port-assignment range. |
| `PM_REGISTRY` | `/var/lib/paddock-servers/ports.json` | Path to the shared ports-registry JSON. |
| `PM_CONFIG` | `/etc/paddock-servers/pm.env` | Optional `KEY=VALUE` config file read for the knobs above (`#` comments and quotes allowed). |
| `PM2_BIN` | `pm2` on `PATH` | Override the PM2 binary. |

A dev/preview server started by `pm` is given an **isolated scratch data dir**
and does not inherit Paddock's production state pointers; `PM_SCRATCH_ROOT`,
`PM_SCRUB_VARS`, and `PM_PROD_DATA_ROOTS` tune that isolation (see the header
comment in `pm` for details).
