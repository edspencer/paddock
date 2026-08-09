---
title: "API overview"
description: "How Paddock's HTTP, WebSocket and MCP surfaces fit together, plus the auth model that applies to all of them."
---

Paddock has three network surfaces, and it matters which one you want:

| Surface | Endpoint | What it's for |
|---------|----------|---------------|
| **REST** | `/api/*` | Reads, project/chat/trigger management, git, instance config, attachment upload + serve. |
| **WebSocket** | `/ws` | The live chat turn: sending a message, streamed replies, tool events, cancel, slash commands, the queue. |
| **MCP** | `/mcp` | The external Management API — Paddock as an MCP server for other agents. |

The split to remember: **REST manages, the WebSocket converses.** Sending a
message is *not* a REST call — it is a `chat:send` frame over `/ws`. The one
place they meet is attachments: upload the bytes over HTTP
(`POST /api/projects/:slug/chats/:sessionId/upload`), then reference the returned
file ids in the `chat:send` frame.

## The endpoint list

The full, authoritative REST reference is the **[HTTP API reference](/api/)** —
Swagger UI over an OpenAPI 3 document that is **generated from the server's
Fastify route schemas**. A new or changed route shows up there automatically,
which is why it, and not a page like this one, is the endpoint list.

It's a static, read-only reference for the latest release, so "Try it out" is
disabled. To exercise the API against your own instance, run Paddock with
`PADDOCK_OPENAPI_ENABLED=1` (it is opt-in, off by default) and open
**`/open-api`** on that instance — same document, live, with the raw spec at
`/open-api.json`.

### Addressing the root workspace

One thing the generated spec shows but does not explain. Every workspace route is
registered **once** and mounted **twice**:

- `/api/projects/:slug<path>` — a named project.
- `/api/root<path>` — the **root workspace**, whose key is the empty string. An
  `onRequest` hook injects `slug: ""` so the handler cannot tell the difference.

So `GET /api/root/chats` is the root workspace's chat list, and every
`/api/projects/:slug/…` route below has an `/api/root/…` twin. That is also why
the root workspace is `project: ""` in the
[self-management MCP](/reference/self-mcp/) and `projectSlug: ""` on the
[WebSocket](/reference/websocket/) — one empty-string key, three spellings of the
same idea.

## Authentication

Every request passes through the auth layer (`packages/server/src/auth.ts`) chosen
by `PADDOCK_AUTH_MODE` (see [CONFIGURATION.md](/configuration/environment) and
[AUTH.md](/configuration/authentication)):

- In **`none`** mode (default) every request is the frozen anonymous principal —
  the API is fully open.
- In **`trusted-header`** / **`jwt`** modes the proxy/IdP identity becomes
  `req.user`, and per-user **read-state** (unread/seen) is keyed by username.
- **Three groups are exempt** from the hook (see
  [Authentication](/configuration/authentication/) for the reasoning on each):
  `GET /api/health` (liveness probe); the compiled front-end bundle — the
  `/assets/`, `/icons/` and `/fonts/` prefixes plus `/sw.js`,
  `/manifest.webmanifest` and `/favicon.ico`; and `/mcp` +
  `/.well-known/oauth-protected-resource` (both prefix-matched), which
  authenticate themselves. Everything else — every `/api` route, the app shell,
  and `/ws` — stays gated.
- There is **no per-resource authorization** — chat visibility is deliberately not
  gated (#189). "Auth" means "the configured mode must admit the request", not
  "this principal owns this chat".

The WebSocket at `/ws` is registered behind the same auth hook, so the mode you
configure covers both surfaces. The security schemes advertised in the OpenAPI
document reflect whichever mode the instance generating it was running.

Responses are JSON unless noted; `:slug`/`:sessionId` errors return
`{ error, code }` with `404` (not found), `409` (exists), or `400` (invalid);
unexpected errors return `500`.

## The WebSocket

The `/ws` frame protocol — envelope, routing block, and every client→server and
server→client frame — is documented at **[WebSocket protocol](/reference/websocket)**.

It lives on its own page because `@fastify/swagger` can only describe HTTP
routes: the WebSocket contract cannot appear in the generated spec, so it stays
hand-maintained.

## MCP (`/mcp`)

Paddock can expose itself as an **MCP server** at `/mcp`, letting other agents
drive it as a tool. Those routes are deliberately hidden from the OpenAPI
document (they are a transport, not a REST resource), so `/mcp` — how to enable
it, its clients, scopes and tools — is [documented separately](/reference/mcp).
