---
"@paddock/server": minor
"@paddock/web": minor
---

feat(management-api): policy layer + config-token authentication for external callers (#312 M1).

The first half of Phase 3 of the self-management MCP epic (#214): everything an
external caller needs *except* the MCP transport itself, which lands in M2. The
`/mcp` endpoint exists and authenticates, but answers `501` until the transport
is mounted.

Management-API auth is **entirely self-contained** — independent of
`PADDOCK_AUTH_MODE` and of any reverse proxy. Paddock authenticates `/mcp`
itself, so it stays credential-gated even at `auth.mode: none`, and a proxy is
never a prerequisite for running Paddock.

- **Ops layer split out of the MCP transport.** `buildSelfMcpServerDef` used to
  build the operation callbacks *and* assemble the MCP server def in one
  function, so a non-MCP caller couldn't reach the operations.
  `buildManagementOps` now constructs them alone; `ws-self-mcp.ts` is reduced to
  transport assembly. `makeChatHandler` additionally returns the shared ops
  context, threaded through `app.ts` into the route layer beside the existing
  `fireTrigger`.
- **Policy is enforced at the ops layer, not per-transport.** Every operation is
  checked against a `ManagementPrincipal` centrally, so the REST parity work in
  #465 inherits identical auth + scope rather than reimplementing it and
  drifting. Enumerating operations filter to the permitted projects; operations
  naming a target assert, and raise a denial the transport maps to `403` +
  `WWW-Authenticate: … error="insufficient_scope"`. The in-process keeper path
  runs under a full-trust internal principal (it is bounded by depth, not scope)
  and bypasses the wrapper, so keeper behaviour is unchanged.
- **Read-only by default.** Any write scope is effectively remote code execution
  on the host — `create_chat` / `send_message` / `fork_chat*` / `run_trigger`
  start keeper turns, and a keeper has `Bash` — so a client configured without an
  explicit scope gets the risk class that cannot execute code, and a scope that
  does grant it is called out loudly at boot.
- **Config tokens are referenced, never inlined.** `auth: { ref: "env:VAR" }`;
  an inline secret in the git-tracked config file is a hard error. A credential
  that won't resolve (unset, or below the length floor) drops *that client* and
  leaves the rest working. Comparison is constant-time over fixed-width digests,
  and a `pdk_<instanceId>_…` token is rejected unless the instance matches, so a
  credential minted for one Paddock is meaningless at another.
- **`managementApi.publicUrl` is required** once clients are configured — RFC
  9728 requires the metadata document's `resource` to byte-match the URL the
  client used, and that can't be derived from an attacker-controlled `Host`
  header. Plaintext is refused for non-loopback hosts, since `/mcp` carries
  bearer tokens.
- **Fail closed.** `/mcp` 404s unless clients *and* a public URL are configured;
  a missing or bad credential is `401` + `WWW-Authenticate`, never a `302` to a
  login page (which no MCP client can follow, and which breaks OAuth discovery).
- **`/.well-known/` and `/mcp` are excluded from the SPA catch-all.** Both are
  extension-less, so the not-found handler previously answered them with the app
  shell and a `200`. That holed the fail-closed guarantee and broke MCP OAuth
  discovery: a client fetching the protected-resource metadata received HTML,
  failed to parse it, and silently fell back to treating Paddock as its own
  authorization server with no error naming the cause.
