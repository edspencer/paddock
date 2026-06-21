# Running Paddock locally (full stack)

Everything you need to run the whole app — server + Max auth token + web SPA —
in one place. Two modes: a **production-like single process** (server serves the
built SPA) and a **hot-reload dev** mode (Vite dev server + watched backend).

## Prerequisites

- **Node 22+** and the **`claude` CLI** on your `PATH` (`claude --version`).
- A **Claude Max OAuth token** in `~/herds/.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
  The server passes it through the process environment to the keeper agents;
  it is never written to any file. (Deployed: the LXC has the same token in env.)
- Dependencies installed: `npm install` (from the repo root).

> Never print the token. Always load it into the environment with
> `set -a; source ~/herds/.env; set +a` — never `echo $CLAUDE_CODE_OAUTH_TOKEN`.

## Mode A — production-like (one process serves API + WS + SPA)

This is exactly how the deployed service runs: the server serves
`packages/web/dist` as the SPA and exposes `/api` + `/ws` on the same origin.

```bash
cd ~/Code/paddock

# 1. Load the Max token into the environment (no value is printed).
set -a; source ~/herds/.env; set +a

# 2. Build both packages (web dist + server dist).
npm run build

# 3. (optional) Use a throwaway data dir so you don't touch real projects.
export PADDOCK_DATA_DIR="$(mktemp -d /tmp/paddock-dev.XXXXXX)"
export PORT=4000            # default; change if 4000 is taken

# 4. Start the single server process.
npm run start              # == node packages/server/dist/index.js
```

Open **http://localhost:4000/** — the SPA, API, and WebSocket chat all live here.

Quick checks (another terminal):

```bash
curl -s http://localhost:4000/api/health     # {"ok":true}
curl -s http://localhost:4000/api/projects    # {"projects":[...]}
```

## Mode B — hot-reload dev (two processes)

Use this while iterating on the frontend. Vite serves the SPA on `:5173` and
**proxies** `/api` + `/ws` to the backend on `:4000` (see `vite.config.ts`), so
the WebSocket chat works end-to-end with live reload.

```bash
cd ~/Code/paddock
set -a; source ~/herds/.env; set +a   # token in env for BOTH terminals

# Terminal 1 — backend (watched, tsx)
npm run dev          # paddock-server on :4000

# Terminal 2 — frontend (Vite, HMR)
npm run dev:web      # http://localhost:5173  (proxies /api + /ws -> :4000)
```

Open **http://localhost:5173/**.

## Stopping

```bash
# Mode A:
pkill -f "packages/server/dist/index.js"
# Mode B: Ctrl-C each terminal.

# If you used a temp data dir:
rm -rf /tmp/paddock-dev.*
```

## Environment variables (server)

| Var | Default | Purpose |
|-----|---------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | **Required.** Max auth, passed to keeper agents. |
| `PORT` | `4000` | HTTP/WS listen port. |
| `HOST` | `0.0.0.0` | Bind host. |
| `PADDOCK_DATA_DIR` | `./data` | Root for projects, scratch, herdctl config + state. |
| `PADDOCK_WEB_DIST` | `packages/web/dist` | Built SPA served in production. |
| `VITE_API_BASE` *(web build)* | same-origin | Point the SPA at a non-default API origin. |
| `VITE_WS_BASE` *(web build)* | same-origin | Point the SPA at a non-default WS origin. |

## What "good" looks like end-to-end

1. App shell loads at `/`, projects grid renders (empty state if no projects).
2. **+ New Project** → modal → create → you land in the project view.
3. **New Chat** in the project → type a message → assistant text streams in as
   markdown with a live caret; tool calls appear as collapsible blocks; the chat
   becomes a resumable session in the left list once it completes.
4. Reload the page, reopen the chat → its transcript hydrates from history.
5. **New one-off chat** (sidebar) → same chat pane against the `scratch` agent.
