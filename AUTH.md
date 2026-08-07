# Authentication

Paddock's **browser surface** has no login of its own. It is designed to run
behind a reverse proxy that has already authenticated the user against an
identity provider (OIDC/SAML/etc.), and to turn that upstream identity into a
`req.user` that the rest of the app can read.

There is one exception, covered at the end of this document: the **Management
API** at `/mcp` authenticates itself with its own credentials, independent of
everything below.

The auth layer is **provider-agnostic** — driven entirely by `PADDOCK_AUTH_*`
environment variables — so it is not tied to any single proxy or IdP. It works
with Authentik, oauth2-proxy, Authelia, Cloudflare Access, Keycloak, and others.

All of it is **optional**. The default (`PADDOCK_AUTH_MODE=none`) is fully open.

---

## The three modes

| Mode | What it trusts | Spoof-proof on its own? | Use when |
|------|----------------|-------------------------|----------|
| `none` (default) | nothing | n/a (open) | Local dev, or trust is entirely handled elsewhere |
| `trusted-header` | a header the proxy sets | **No** — relies on the proxy + network | The proxy is the *only* path to Paddock |
| `jwt` | a signed JWT verified against a JWKS | **Yes** | Zero-trust; safe even if a request reaches Paddock directly |

### Security note

`none` and `trusted-header` provide **no cryptographic guarantee**. In
`trusted-header` mode, anything that can reach Paddock can forge the identity
header. That is only acceptable when the network guarantees the proxy is the
sole ingress (e.g. Paddock binds a private interface / Docker network and the
proxy is the one hop in front of it).

**`jwt` mode is the only spoof-proof option.** Paddock verifies the token's
signature itself against the IdP's JWKS, so a forged or replayed-without-key
token is rejected even if it arrives directly. Paddock holds **no key material**
— only the JWKS URL. Key rotation is handled automatically (`jose`'s
`createRemoteJWKSet` fetches + caches the JWKS).

Either way, **Paddock's health endpoint is always exempt** so the proxy and
monitoring can probe a locked-down server: **`/api/health`**, which answers
`200 {"ok":true}` as `application/json`. It is the only exempt health path — point
every liveness/readiness probe at it (the shipped `Dockerfile` HEALTHCHECK and the
Kubernetes probes both do).

> **No `/healthz` alias.** Paddock does not serve `/healthz`, `/-/health`,
> `/health`, `/readyz` or `/livez`. Earlier versions of this document listed them
> as exempt, but no route was ever registered — so with the SPA mounted they were
> answered by the front-end catch-all with `200 text/html`, and a probe pointed at
> one reported healthy no matter what state the app was in. They are now gated like
> any other unknown path (`401` in `trusted-header`/`jwt` mode). If you have a probe
> on one of them, repoint it at `/api/health` (issue #569).

### Safe-by-default binding

Because `none` is fully open, Paddock **won't let you expose it unauthenticated
by accident**. This is what makes `npx @edspencer/paddock` on a laptop safe with no
configuration: it binds loopback, so "no authentication" means "reachable only from
this machine". You need to read the rest of this file when you put Paddock somewhere
other people can reach.

The bind host defaults to **`127.0.0.1`** (loopback only), and if
you bind a non-loopback host (e.g. `0.0.0.0`) while `PADDOCK_AUTH_MODE=none`,
startup **fails closed** with a clear message — the same fail-closed posture as
`jwt` mode without a JWKS URL. To bind a routable interface, do one of:

- put a real auth mode (`trusted-header`/`jwt`) or a reverse proxy in front — no
  flag needed;
- keep the bind on loopback and reach Paddock via a proxy/sidecar on the same host;
- or, **only if you truly intend an open, unauthenticated server**, set
  `PADDOCK_DANGEROUSLY_ALLOW_OPEN=1` — it boots but logs a loud warning.

(Inside a container the network namespace is the boundary and Docker can't reach
`127.0.0.1` in the container, so the image binds `0.0.0.0` and the deploy recipe
carries the safe host-side publish — see the Securing guide.)

---

## Environment variables

| Variable | Mode | Default | Purpose |
|----------|------|---------|---------|
| `PADDOCK_AUTH_MODE` | all | `none` | `none` \| `trusted-header` \| `jwt` |
| `PADDOCK_AUTH_USER_HEADER` | trusted-header | `X-Forwarded-User` | Header carrying the username (required in this mode) |
| `PADDOCK_AUTH_EMAIL_HEADER` | trusted-header | — | Optional header carrying the email |
| `PADDOCK_AUTH_GROUPS_HEADER` | trusted-header (also jwt override) | — | Optional header carrying groups (comma/space-split) |
| `PADDOCK_AUTH_JWT_HEADER` | jwt | `Authorization` | Header carrying the JWT. If `Authorization`, a leading `Bearer ` is stripped |
| `PADDOCK_AUTH_JWKS_URL` | jwt | — | **Required in jwt mode.** The IdP's JWKS endpoint |
| `PADDOCK_AUTH_JWT_ISSUER` | jwt | — | Optional; validate the `iss` claim |
| `PADDOCK_AUTH_JWT_AUDIENCE` | jwt | — | Optional; validate the `aud` claim |
| `PADDOCK_AUTH_USERNAME_CLAIM` | jwt | — | Claim to read the username from. Default tries `preferred_username` → `email` → `sub` |
| `PADDOCK_AUTH_GROUPS_CLAIM` | jwt | `groups` | Claim to read group membership from |

In `jwt` mode, Paddock validates `iss`/`aud` only when you set them, and always
validates the signature and expiry (`exp`). Supported signature algorithms are
the asymmetric ones JWKS publishes (RS256, ES256, etc.).

If `PADDOCK_AUTH_MODE=jwt` is set **without** `PADDOCK_AUTH_JWKS_URL`, Paddock
**refuses to start** (fails closed, loudly) rather than booting an
auth-misconfigured server.

---

## What `req.user` looks like

After the auth hook runs, every request carries:

```ts
interface AuthUser {
  username: string;     // from header/claim
  email?: string;       // when the provider supplies it
  groups?: string[];    // when supplied
  anonymous?: boolean;  // true only in `none` mode
}
```

In `none` mode this is the synthetic `{ username: "anonymous", anonymous: true }`.

---

## Provider examples

### Authentik (forward-auth, jwt mode) — our deployment

Authentik's forward-auth outpost injects a signed JWT in the `X-authentik-jwt`
header. Each Authentik *application* exposes its own JWKS at
`https://<authentik-host>/application/o/<app-slug>/jwks/`.

```bash
PADDOCK_AUTH_MODE=jwt
PADDOCK_AUTH_JWT_HEADER=X-authentik-jwt
PADDOCK_AUTH_JWKS_URL=https://sso.example.com/application/o/<app-slug>/jwks/
# optional hardening:
# PADDOCK_AUTH_JWT_ISSUER=https://sso.example.com/application/o/<app-slug>/
# PADDOCK_AUTH_JWT_AUDIENCE=<client-id>
```

Username maps from `preferred_username` by default; groups from `groups`.

> The proxy (Caddy + Authentik outpost) handles `/outpost.goauthentik.io/*`
> itself — those paths never reach Paddock, so no exemption is needed for them.

### oauth2-proxy (trusted-header)

oauth2-proxy sets `X-Forwarded-User` / `X-Forwarded-Email` (enable
`--set-xauthrequest` / `--pass-user-headers`). Make sure Paddock is only
reachable through oauth2-proxy.

```bash
PADDOCK_AUTH_MODE=trusted-header
PADDOCK_AUTH_USER_HEADER=X-Forwarded-User
PADDOCK_AUTH_EMAIL_HEADER=X-Forwarded-Email
PADDOCK_AUTH_GROUPS_HEADER=X-Forwarded-Groups
```

oauth2-proxy can alternatively pass a JWT (`--pass-access-token` /
`Authorization: Bearer`), in which case use `jwt` mode with the IdP's JWKS URL.

### Cloudflare Access (jwt mode)

Cloudflare Access injects a signed JWT in the `Cf-Access-Jwt-Assertion` header
and publishes a JWKS per team.

```bash
PADDOCK_AUTH_MODE=jwt
PADDOCK_AUTH_JWT_HEADER=Cf-Access-Jwt-Assertion
PADDOCK_AUTH_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
PADDOCK_AUTH_JWT_AUDIENCE=<application-aud-tag>
PADDOCK_AUTH_USERNAME_CLAIM=email
```

### Authelia / Keycloak

Authelia (`Remote-User` / `Remote-Email` / `Remote-Groups`) works in
`trusted-header` mode; Keycloak issuing a `Bearer` JWT works in `jwt` mode with
the realm JWKS (`.../realms/<realm>/protocol/openid-connect/certs`).

---

## The Management API (`/mcp`) — a separate credential

Everything above governs the **browser surface**: `/api`, `/ws`, and the SPA.
The external Management API is deliberately **not** part of it.

`/mcp` (and its `/.well-known/oauth-protected-resource*` metadata) is exempt
from the `onRequest` auth hook — not because it's open, but because it runs its
own credential check first. Paddock authenticates that surface **itself**, so it
stays gated even on an instance running `PADDOCK_AUTH_MODE=none`, and it does
not inherit or depend on your proxy's identity.

Practical consequences:

- **A proxy-level auth layer must exempt `/mcp`.** MCP clients present a bearer
  token; they can't complete an interactive SSO redirect. Send a bad credential
  and Paddock replies `401` with a `WWW-Authenticate` challenge — never a
  redirect to a login page. If your proxy intercepts `/mcp` with Basic Auth or
  an OIDC flow, MCP clients will fail before reaching Paddock.
- **Read-only is the default, and widening it is a serious grant.** A client
  configured without an explicit scope gets `list_projects`, `list_chats`,
  `list_triggers` and `read_chat`. Any *write* scope can start a turn,
  and Claude has `Bash` — **granting write on the Management API is
  equivalent to granting remote code execution on the host.** Scope such tokens
  to specific projects, treat them like SSH keys, and watch for the named
  warning the config loader logs at boot when a client holds one.
- **Static bearer tokens only.** `auth.type` accepts `"token"` and nothing else;
  OAuth is not implemented, so RFC 9728 discovery metadata is published only
  once an authorization server is configured — which no shipped path does yet.
- **Tokens are referenced, never inlined.** Clients declare
  `auth: { ref: "env:VAR_NAME" }` (the only supported scheme); an inline
  `token`/`secret` key in the git-tracked config file is a hard error and the
  client is skipped.
- **It fails closed.** With no `clients`, or no `publicUrl`, `/mcp` returns
  `404` — the endpoint doesn't exist rather than opening up. The same happens if
  every configured client's token fails to resolve.

Setup, the scope grammar, and the per-tool reference live in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#management-api-mcp-external-callers)
and on the [documentation site](https://paddock.edspencer.net/reference/mcp/).

---

## Implementation notes

- The Management API's own auth lives in
  `packages/server/src/management-auth.ts` (credential check) and
  `packages/server/src/management-policy.ts` (scope enforcement), with the
  transport in `packages/server/src/routes/mcp.ts`. Policy is enforced at the
  operations layer, so the in-process path and the external HTTP path
  share one implementation rather than two.
- Wiring lives in `packages/server/src/auth.ts`; config in
  `packages/server/src/config.ts` (`cfg.auth`). It is registered in
  `packages/server/src/app.ts` as an `onRequest` hook **before** the routes and
  the WebSocket handler, so it guards both REST and `/ws`.
- The verification library is [`jose`](https://github.com/panva/jose)
  (`createRemoteJWKSet` + `jwtVerify`) — dependency-light and standards-based.
- `req.user` is exposed via a Fastify request decorator (TypeScript-augmented),
  so any route/handler can read it without extra plumbing.
