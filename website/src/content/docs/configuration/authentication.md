---
title: "Authentication"
description: "Auth modes (none / trusted-header / jwt) and how Paddock handles credentials and secrets."
---

Paddock has **no login of its own**. It is designed to run behind a reverse
proxy that has already authenticated the user against an identity provider
(OIDC/SAML/etc.), and to turn that upstream identity into a `req.user` that the
rest of the app can read.

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

Either way, **health/readiness endpoints are always exempt** so the proxy and
monitoring can probe a locked-down server: `/api/health` (Paddock's own),
`/healthz`, `/-/health`, `/health`, `/readyz`, `/livez`.

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
PADDOCK_AUTH_JWKS_URL=https://sso.valfenda.net/application/o/<app-slug>/jwks/
# optional hardening:
# PADDOCK_AUTH_JWT_ISSUER=https://sso.valfenda.net/application/o/<app-slug>/
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

## Implementation notes

- Wiring lives in `packages/server/src/auth.ts`; config in
  `packages/server/src/config.ts` (`cfg.auth`). It is registered in
  `packages/server/src/app.ts` as an `onRequest` hook **before** the routes and
  the WebSocket handler, so it guards both REST and `/ws`.
- The verification library is [`jose`](https://github.com/panva/jose)
  (`createRemoteJWKSet` + `jwtVerify`) — dependency-light and standards-based.
- `req.user` is exposed via a Fastify request decorator (TypeScript-augmented),
  so any route/handler can read it without extra plumbing.
