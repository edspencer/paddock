# `scripts/`

Standalone helper scripts used to develop, test, and package Paddock. They are
not part of the app build (the `packages/*` workspaces are) — most are `.mjs`
(ESM) or `.sh`; the extensionless `pm` is a CommonJS Node script, which is why
this directory carries its own `package.json` (`"type": "commonjs"`) so it does
not inherit the repo root's `"type": "module"`.

## `check-no-nul-bytes.mjs` — CI guard against raw NUL bytes

`npm run check:nul` walks every `.ts`/`.tsx`/`.mjs`/`.js` file in the repo
(skipping `node_modules` and build output) and fails if any contains a literal
`0x00` byte, reporting `file:line:col`. Data files — `.json`, `.md` — are
deliberately not scanned: the guard is about *source* staying greppable, and a
NUL in a JSON fixture is more likely to be intentional test data.

A raw NUL inside a string literal is identical at runtime to the `\u0000`
escape, so nothing about the program's behaviour betrays it — but ripgrep and
grep classify the containing file as **binary** and skip it during directory
traversal, silently, with exit code 1, indistinguishable from an honest "no
matches". Two such bytes once hid 1,249 lines of `packages/server/src` —
including `ws.ts`, the busiest file in the server — from every recursive
search. Because the byte renders as nothing in a terminal, it is also invisible
in diffs, so neither review, typecheck, nor the test suite catches it. Hence a
dedicated check, wired into CI ahead of `npm ci` (issue #570). It originally
scanned only `packages/**/*.ts`, which missed a second real occurrence in
`scripts/demo-gif/seed.mjs`; #642 widened it to the whole repo.

The fix is always to spell the character as an escape rather than paste the raw
byte — see the `KEY_SEP` constants in `packages/server/src`.

## `demo-gif/` — regenerate the README / docs demo GIF

`npm run demo:gif` seeds a throwaway synthetic Paddock instance, boots it, drives
a couple of live turns, photographs eight beats with Playwright, and encodes the
result to GIF (plus MP4/WebM). It writes both committed copies of the asset —
`docs/demo/paddock-demo.gif` and `website/public/demo/paddock-demo.gif`.

Everything it shows is invented: no production data, no real repositories. See
[`demo-gif/README.md`](demo-gif/README.md) for how to change the storyboard, and
for the list of things that fail silently if you get them wrong.

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
