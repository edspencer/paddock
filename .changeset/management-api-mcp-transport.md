---
"@paddock/server": minor
"@paddock/web": minor
---

feat(management-api): mount the streamable-HTTP MCP transport at `/mcp` (#312 M2).

Stacked on the M1 policy layer. An external MCP client — a laptop Claude Code
session, or eventually a peer Paddock — can now drive the management operations
over HTTP, bounded by the scope its credential carries.

The toolset is **not** redefined for external callers: the same
`InjectedMcpServerDef` a keeper receives in-process is adapted onto the MCP SDK,
so adding a self-MCP tool exposes it over `/mcp` with no further work, and a
client's toolset upgrades when the server does.

- **Transport:** `@modelcontextprotocol/sdk@1.29.0` (protocol revision
  `2025-11-25`), `WebStandardStreamableHTTPServerTransport`, **stateless** — a
  fresh server and transport per request, so there is no session store, restarts
  are transparent, and one principal's tool visibility cannot leak into another's
  session. Implemented against the low-level `Server` so the existing
  hand-written JSON Schemas pass through verbatim rather than round-tripping
  through Zod.
- **Scope shapes the wire.** A read-only client is *offered* only read verbs, and
  a call to a verb it wasn't offered is refused rather than executed. Project
  scoping keeps the M1 split: enumerations filter, explicitly-addressed targets
  are denied.
- **`GET`/`DELETE` answer `405`.** In stateless mode a `GET` would open an SSE
  stream that never emits, leaving the client waiting on a header-less socket.
- **Response headers are flushed before the body.** Node buffers `writeHead()`
  until the first byte, so a slow tool call — and every turn-spawning operation
  is one — would otherwise stall the *headers* for its whole duration and read as
  a hang to any proxy with a response-header timeout.
- **RFC 9728 discovery** at the path-inserted
  `/.well-known/oauth-protected-resource/mcp` (plus the root form), served
  unauthenticated with permissive CORS — a client fetches it before holding any
  credential. Published **only when `managementApi.authorizationServers` is
  configured**: the MCP spec makes `authorization_servers` mandatory, and a
  token-only deployment has none, so it publishes nothing rather than a document
  that sends clients hunting for an authorization server that doesn't exist.
- **OAuth scopes** (`paddock:read` / `paddock:write`) are a coarse projection of
  the fine-grained operation lists, used only in challenges and discovery —
  because those are read by humans on a consent screen. Authorization is still
  decided on the operation list.
