---
title: "Management API (MCP)"
description: "The external /mcp endpoint: how it authenticates itself, its scopes and read-only default, the RFC 9728 discovery document, and the full response matrix."
---

Paddock can expose itself as an **MCP server** at **`/mcp`**, so a caller
*outside* the instance — a Claude Code session on your laptop, a CI job, or a
peer Paddock — can drive the same operations a keeper reaches through its
in-process `paddock_manage` tools.

External callers get the **same toolset a keeper receives**, minus whatever their
credential's scope hides. Nothing is redefined for the external surface, so a
tool added to the self-management MCP appears over `/mcp` for free and the two
can't drift.

:::danger[Any write scope is remote code execution on the host]
`create_chat`, `send_message`, `fork_chat`, `fork_chat_batch`, `run_trigger` and
`set_trigger` **start keeper turns**, and a keeper runs with `Bash` and `Write`.
`create_project` clones a caller-supplied git URL. Granting any of those to a
client is granting code execution on the machine Paddock runs on.

That is why a client configured without an explicit `scope` gets **read-only**,
and why a token that carries a write scope must be treated as a production
secret.
:::

## Three things to know first

- **It authenticates itself.** The `/mcp` gate is completely independent of
  `PADDOCK_AUTH_MODE` and of any reverse proxy. The endpoint stays
  credential-gated even on an instance running `auth.mode: none`, and running
  Paddock with no proxy at all is fully supported. `/mcp` is *exempt* from the
  browser auth hook precisely because it runs its own authenticator in its place.
- **It fails closed.** With no `managementApi.clients` — or no `publicUrl` —
  `/mcp` returns **404**. The endpoint does not exist until an operator
  deliberately turns it on. `/mcp` and `/.well-known/` are also excluded from the
  SPA catch-all, so an unconfigured instance 404s honestly instead of answering
  a machine surface with the app shell and a `200`.
- **Token material is referenced, never inlined.** `paddock.config.yaml` is
  git-tracked (and editable from the instance Config screen), so a literal
  `token:` or `secret:` in it is a **hard config error**, not a warning.

## Endpoints

| Method | Path | Auth | What it is |
|--------|------|------|------------|
| `POST` | `/mcp` | Bearer token | The streamable-HTTP JSON-RPC MCP endpoint. |
| `GET`, `DELETE` | `/mcp` | Bearer token | **`405`** + `Allow: POST` — *once authenticated*. The gate runs first, so without a valid token these are a `401` like any other request. |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | **None** | RFC 9728 protected-resource metadata (path-inserted form). |
| `GET` | `/.well-known/oauth-protected-resource` | **None** | The same document at the bare root. |

### `POST /mcp`

The transport is **stateless**: a fresh MCP server *and* transport are built per
request, bound to the authenticated principal, with no session store and no
cross-request state. Restarts are transparent to clients, and one caller's tool
visibility can never leak into another's session.

The MCP server identifies itself as `paddock` in the `initialize` handshake, with
the Paddock package version as its version string.

A **successful** `POST` is answered as `Content-Type: text/event-stream`, not
`application/json` — the streamable-HTTP transport frames its reply as a
single SSE event:

```text
event: message
data: {"result":{"tools":[…]},"jsonrpc":"2.0","id":1}
```

That is a normal `200`. It matters mostly when you're testing by hand, since
a `curl` expecting bare JSON will look like it failed.

### `GET`/`DELETE /mcp` → `405`

Refused explicitly rather than silently. In stateless mode the transport answers
a `GET` with an SSE stream that never emits anything, so a client would hang
forever on a socket that never gets headers. Paddock replies `405` with
`Allow: POST` and a JSON-RPC error body instead.

The auth gate runs **before** the method check, though, so this is what an
*authenticated* `GET` gets. An unauthenticated one — opening `/mcp` in a browser,
say — is a plain `401`.

### The discovery document

`GET /.well-known/oauth-protected-resource/mcp` is **unauthenticated by design** —
a client fetches it *before* it holds any credential, so gating it would make
discovery impossible. The document names the authorization server and the
supported scopes; it never contains a secret. It is served with
`Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=300`.

Two details matter:

- **The URL is path-*inserted*, not path-appended.** For a resource at
  `https://paddock.example.com/mcp` the metadata lives at
  `https://paddock.example.com/.well-known/oauth-protected-resource/mcp`. A
  verified trace of a real Claude Code session showed it requests **only** that
  form and never the bare root. Paddock serves both and relies on the
  path-inserted one.
- **It is published only when `authorizationServers` is set.** RFC 9728 makes
  `authorization_servers` optional, but the MCP specification makes it mandatory,
  and a token-only deployment has no authorization server. Rather than publish a
  document the governing spec calls invalid, Paddock publishes **nothing** — the
  URL `404`s. A client holding a static bearer token never performs discovery, so
  nothing is lost on the supported path.

```json
{
  "resource": "https://paddock.example.com/mcp",
  "authorization_servers": ["https://idp.example.com/application/o/paddock/"],
  "scopes_supported": ["paddock:read", "paddock:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Paddock Management API"
}
```

`resource` is built from the operator-configured `publicUrl`, never from the
`Host` header: RFC 9728 §3.3 requires the client to byte-match it against the URL
it used, behind a TLS-terminating proxy the derived scheme would be wrong, and
`Host` is attacker-controlled anyway.

## The response matrix

The gate runs in Fastify's `onRequest` hook — **before body parsing** — so a
malformed or oversized body can never preempt the auth decision. The checks run
in this order:

| Status | When | Body / headers |
|--------|------|----------------|
| **404** | `managementApi.clients` is empty, or `publicUrl` is unset. | `{ "error": "not found" }` |
| **403** | Plaintext request from a **non-loopback** client ([caveat](#plaintext-is-refused--as-defence-in-depth)). | `code: "insecure_transport"` |
| **401** | Credential missing, malformed, or matching no configured client. | `WWW-Authenticate: Bearer …`, `code: "auth_required"` |
| **405** | `GET` or `DELETE` on `/mcp`, **after** the gate has passed. | `Allow: POST`, JSON-RPC error `-32000` |
| **503** | The surface is configured but the route has no ops context (a wiring error, not a client error). | `code: "ops_unavailable"` |
| **406** | The request didn't send `Accept: application/json, text/event-stream`. Enforced by the MCP transport, so it lands *after* the gate above. | JSON-RPC error `-32000`, `Not Acceptable: Client must accept both application/json and text/event-stream` |
| **200** | Everything else — the JSON-RPC response, including in-band tool errors. **SSE-framed** ([above](#post-mcp)), not bare JSON. | `Content-Type: text/event-stream` |

Note the ordering: the gate is method-agnostic, so an unauthenticated `GET` is a
`401` rather than the `405` you might expect, and a request missing its `Accept`
header still has to get past auth before the `406`.

### Never a `302`

An unauthenticated request gets **`401` plus a `WWW-Authenticate` challenge —
never a redirect to a login page.** An MCP client cannot follow an HTML login
redirect, and OAuth discovery reads this exact challenge. This is the single
biggest reason the endpoint must not be left to an SSO proxy.

```http
WWW-Authenticate: Bearer realm="paddock", error="invalid_token",
  error_description="the access token is invalid",
  resource_metadata="https://paddock.example.com/.well-known/oauth-protected-resource/mcp"
```

The `error`/`error_description` parameters are omitted when no credential was
presented at all, and `resource_metadata` is present only when a discovery
document will actually be served — pointing a client at a URL that then `404`s is
worse than omitting the pointer.

### Plaintext is refused — as defence in depth

A request counts as secure if it arrived over real TLS at the Paddock process, if
a TLS-terminating proxy set `X-Forwarded-Proto: https`, or if the client is on
loopback (nothing left the host, so there is no wire to sniff). Anything else is
a bearer token readable in transit, and gets **`403 insecure_transport`**.

:::caution[This guard is a footgun-preventer, not a guarantee — see [#474](https://github.com/edspencer/paddock/issues/474)]
`X-Forwarded-Proto` is currently honoured from **any** peer. Paddock configures no
trusted-proxy list, so *the client itself* can send `X-Forwarded-Proto: https`
over a plaintext connection and satisfy the check.

That is **not** an authentication bypass — a valid bearer token is still
required, and an attacker gains nothing they couldn't already do. The risk runs
the other way: the guard exists to stop **the operator** leaking their own token
over cleartext, and the operator is exactly who can switch it off by accident.
A `403` here that gets "fixed" by adding the header is a copy-paste away from
shipping a bearer token in the clear while believing the guard has your back.

So do not read a `200` as proof the token didn't cross the network readable.
**Terminate TLS in front of `/mcp` and verify that yourself**; treat the bearer
token as the real security boundary.
:::

One case where this bites in normal operation: **a container's published port is
not loopback from inside.** Docker publishing `127.0.0.1:4000` still NATs the
peer address to something like the bridge gateway, so Paddock sees a non-loopback
client and an in-container plaintext smoke test `403`s even though nothing left
the host. Adding `-H "X-Forwarded-Proto: https"` is a legitimate workaround
*there* — and precisely the habit that turns dangerous when copy-pasted onto a
real network.

There is a config-time half of the same rule, and it is not header-spoofable: a
non-loopback `publicUrl` must be `https`, or the whole management API is disabled
at startup.

### How a scope refusal actually surfaces

Two distinct mechanisms, and it's worth being precise:

- **Out-of-scope tools are hidden.** A tool a principal isn't granted is simply
  absent from `tools/list`, so a client never offers its model a verb it can't
  use. Calling it by name anyway gets the same answer as a typo — an MCP tool
  error, `Unknown tool: …`.
- **A denial *during* a call is reported in-band.** A policy refusal comes back
  as an MCP tool result with `isError: true` and a readable message
  (`not permitted: operation "…" is outside this client's scope`), carried on an
  HTTP `200`. That is deliberate: the model needs to read it, and blowing up the
  JSON-RPC layer would not tell it anything.

:::note[`insufficient_scope` is a request-level shape]
Paddock has the RFC 6750 §3.1 `403` + `WWW-Authenticate: … error="insufficient_scope"`
builders, and they are the right shape for a **request**-level refusal — the
planned REST surface will use them. Over `/mcp` today a scope refusal happens
*inside* a tool call, which is already past that point, so it is reported in-band
as above rather than as an HTTP `403`. The only `403` `/mcp` emits is
`insecure_transport`.
:::

## Authentication

A caller presents a bearer token:

```http
POST /mcp HTTP/1.1
Authorization: Bearer pdk_my-paddock_1a2b3c…
Content-Type: application/json
```

- **Config tokens only** in this release. `auth.type` accepts `token`; anything
  else is a config error.
- **Constant-time comparison.** Both sides are hashed to a fixed-width digest
  before comparison, so the check leaks neither content nor length through
  timing. Every configured client is scanned without early exit, so total work
  doesn't depend on *which* client matched.
- **Minimum length 24 characters**, measured across the **whole** token including
  any `pdk_<instanceId>_` prefix. Not a strength guarantee — a floor that stops
  `changeme` from ever authenticating a turn-spawning client. A shorter token
  drops the client with a warning.
- **The `pdk_` prefix binds a token to one instance.** A token shaped
  `pdk_<instanceId>_<secret>` is refused unless its embedded instance id matches
  `managementApi.instanceId`, so copying a credential to a second Paddock does
  not make it work there even though the bytes are identical. An unprefixed token
  still works, but logs a warning that it is *not* bound — and the prefix gives
  secret scanners something to match on. Binding is only *enforced* when
  `instanceId` is configured; with no `instanceId`, a `pdk_anything_…` token is
  accepted as-is.

:::caution[An `instanceId` containing `_` can never authenticate]
The embedded id is parsed as everything between `pdk_` and the **next `_`**. So
an `instanceId` of `my_paddock` and a token `pdk_my_paddock_<secret>` yields an
embedded id of `my`, which never matches the configured `my_paddock` — and
**every request 401s**, with only a boot warning to explain it. Use hyphens.
:::

Generate one like this:

```sh
printf 'pdk_%s_%s' my-paddock "$(openssl rand -hex 24)"
```

### Independent of `PADDOCK_AUTH_MODE`

This is the invariant to hold on to: **Paddock authenticates the management
surface itself.** The browser auth modes are actively wrong for it —

- `jwt` mode reads `Authorization`, which collides head-on with the MCP client's
  own `Authorization: Bearer <management token>`;
- an SSO proxy answers with an HTML login redirect that no MCP client can follow.

So `/mcp` and `/.well-known/oauth-protected-resource*` are exempt from the
browser auth hook, and this authenticator gates them instead. The exemption is
safe *only* because that authenticator exists. See
[Securing Paddock](/guides/securing/#the-mcp-management-api) for what that means
at your edge proxy — including a deploy-ordering hazard worth reading before you
touch a proxy config.

## Scopes and policy

Policy is enforced at the **operations layer, not in the transport.** Any
transport that obtains a principal inherits identical checks for free, and a new
one cannot forget them — so there is no per-transport bypass, and no drift
between MCP and the REST surface that will follow.

### Read-only by default

A client configured with no `scope` gets:

```yaml
projects: ["*"]
allow: ["list_*", "read_chat"]
deny: []
```

which covers `list_projects`, `list_chats`, `list_triggers` and `read_chat` and
excludes every mutating verb.

### The scope fields

| Field | Default | Meaning |
|-------|---------|---------|
| `projects` | `["*"]` | Project slugs this client may touch. Empty reaches nothing. |
| `allow` | `["list_*", "read_chat"]` | Operations it may invoke. Empty grants nothing. |
| `deny` | `[]` | Operations refused. **Deny always beats allow.** |
| `denyProjects` | *(none)* | Projects refused. Beats `projects`. |
| `maxSpawnDepth` | *(instance/project default)* | Recursion bound on turns this client starts. |

A call must satisfy **both** dimensions: the operation *and* the project.

### The operation names

`allow`/`deny` entries are the self-MCP tool names, one for one — writing
`allow: [read_chat]` names the same thing a keeper sees as
`mcp__paddock_manage__read_chat`.

| Class | Operations |
|-------|------------|
| Read | `list_projects`, `list_chats`, `read_chat` |
| Write | `create_project`, `create_chat`, `fork_chat`, `send_message`, `fork_chat_batch`, `archive_chat`, `unarchive_chat` |
| Triggers | `list_triggers`, `set_trigger`, `remove_trigger`, `run_trigger` |

Matching is deliberately **not** a general glob — a security predicate should be
trivially auditable. Exactly two forms are supported: the bare `"*"`, and a
trailing-`*` prefix (`"list_*"`). Anything fancier (`?`, `[]`, an embedded `*`)
is treated as a literal, so a typo'd pattern fails **closed** rather than
accidentally widening a grant. An operation outside the catalogue above is
refused regardless of the allow-list, so a stale `"*"` can't reach a tool policy
hasn't been taught about.

Some consequences worth knowing:

- **Enumerating filters; addressing refuses.** `list_projects` / `list_chats`
  return a *filtered* view for a scoped client — "show me what I can see" is a
  reasonable request. An operation that names a target explicitly is asserted
  instead, and an out-of-scope slug is refused loudly.
- **A read-only client's write tools are absent, not present-and-refusing.** If a
  principal is granted no write or trigger operation, the whole write bag is
  dropped before the toolset is assembled.
- **`fork_chat_batch` needs `fork_chat`.** The batch fan-out executes through
  `fork_chat`, so it is hidden without that grant rather than offered and denied
  on every call.
- **The keeper-side capability gates do not apply here.** `PADDOCK_SELF_MCP`,
  `PADDOCK_SELF_MCP_WRITE`, `PADDOCK_SELF_MCP_PROJECTS` and `PADDOCK_HOOKS_MCP`
  bound what a **keeper** may reach in-process. An external client is bounded by
  its **credential** instead: it gets `create_project` (or any other verb) only
  by naming it in `allow`, and the read-only default excludes them all.

### `paddock:read` / `paddock:write`

Two granularities exist on purpose. Internally a scope is a list of **operation**
names — the right granularity for an operator writing a config file, who wants to
say exactly which verbs a CI token may call. Over OAuth, scopes are coarse
(`paddock:read`, `paddock:write`) because they are shown to a *human* on a consent
screen: "grant write access" is a prompt someone reads; a list of fourteen verbs
is not.

The coarse names are a **projection** used only in the discovery document and in
challenge `scope` parameters. **Authorization is always decided on the
fine-grained list.** `list_triggers` maps to `paddock:read`; everything that
mutates state or starts a turn maps to `paddock:write`.

## Config schema

The `managementApi` block is **file-only** — there is no `PADDOCK_MANAGEMENT_*`
environment equivalent, because a client list doesn't express well as a scalar.
It lives in [`paddock.config.yaml`](/configuration/config-file/).

```yaml
managementApi:
  # Identifies THIS instance. A token minted as `pdk_<instanceId>_<secret>` is
  # refused unless this matches.
  instanceId: my-paddock

  # The canonical public origin clients reach this instance at, no trailing
  # slash. REQUIRED once `clients` is set. Must be https unless it's loopback.
  publicUrl: https://paddock.example.com

  # OAuth issuers, advertised in the RFC 9728 document. Leave empty (the
  # default) for a token-only deployment — no document is published.
  authorizationServers: []

  clients:
    my-laptop:
      auth:
        # `env:VAR_NAME` is the ONLY supported form. An inline token: or
        # secret: here is a hard config error.
        ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP
      # Omit `scope` entirely for the read-only default.

    ci:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_CI
      scope:
        projects: [website]        # `["*"]` for all; omit for all
        allow: [list_*, read_chat, create_chat]
        deny: [archive_chat]       # deny always beats allow
        maxSpawnDepth: 1
```

| Field | Default | Purpose |
|-------|---------|---------|
| `instanceId` | — | Binds `pdk_<instanceId>_…` tokens to this instance. Absent ⇒ binding is not enforced. |
| `publicUrl` | — | **Required whenever `clients` is set.** Canonical public origin, optionally with a path for a path-mounted deployment; `https` unless loopback; no query string or fragment; trailing slash stripped. |
| `authorizationServers` | `[]` | OAuth issuer URLs. **Gates whether the discovery document is published at all.** |
| `clients.<id>.auth.type` | `token` | Credential type. Only `token` is supported. |
| `clients.<id>.auth.ref` | — | **Required.** `env:VAR_NAME` holding the token. |
| `clients.<id>.scope.*` | read-only | See [the scope fields](#the-scope-fields). |

The client key (`my-laptop`, `ci`) is the `clientId` — the stable identity that
gets logged and stamped as provenance. The credential itself never is.

### Failure posture

Two kinds of problem, handled differently on purpose:

- **Malformed config is an error.** An inline secret, an unknown `auth.type`, a
  missing or non-`env:` `ref` — the operator wrote something meaningless, so it
  is logged at error level and that client is skipped. A bad `publicUrl` (or a
  missing one when clients exist) disables the whole management API.
- **An unresolvable reference drops that client** with a loud warning, leaving
  the others working. The env var being unset, blank, or under 24 characters
  means the credential simply doesn't exist, so nothing can authenticate as that
  client. If *every* client drops, `/mcp` reverts to its unconfigured `404` — the
  endpoint ceases to exist rather than opening up.

A scope that grants any code-execution operation is called out at boot with an
explicit warning naming the client. Watch your logs after changing this block.

At boot the surface reports itself one way or the other:

```text
management API: /mcp enabled (self-authenticated — independent of PADDOCK_AUTH_MODE and of any proxy)
management API: /mcp disabled (no managementApi.clients configured) — the endpoint 404s
```

The enabled line carries the enabled client ids and the `instanceId` as
structured fields. The disabled line is worded a little too narrowly: it prints
whenever the **resolved** client list is empty, which includes a config that has
`clients` but whose `publicUrl` was missing or invalid — that discards every
client. The `error`-level line immediately above names the real cause.

## Setting one up

The whole minimal configuration is a token in the environment and this in
`paddock.config.yaml`:

```yaml
managementApi:
  instanceId: my-paddock
  publicUrl: https://paddock.example.com
  clients:
    my-laptop:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP
      # no scope ⇒ read-only across all projects
```

For the step-by-step version of that — minting the token, where to put it for
systemd / Docker / Compose, the `claude mcp add` invocation, how to reach the
endpoint over TLS with no proxy of your own, and a troubleshooting table keyed by
status code — see **[Connect Claude Code to
Paddock](/guides/connect-claude-code/)**.

To grant that client writes later, add an explicit `allow` — and re-read the
warning at the top of this page first.

## See also

- **[Connect Claude Code to Paddock](/guides/connect-claude-code/)** — the
  guide-level walkthrough of the read-only setup above.
- **[Securing Paddock](/guides/securing/#the-mcp-management-api)** — the edge-proxy
  exemption every auth scheme needs, and the deploy-ordering hazard.
- **[Config file (YAML)](/configuration/config-file/)** — where `managementApi`
  lives and how it layers with the environment.
- **[API overview](/reference/api/)** — how `/mcp` relates to REST and `/ws`.
