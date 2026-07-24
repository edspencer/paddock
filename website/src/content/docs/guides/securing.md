---
title: Securing Paddock
description: Paddock has no built-in login. Put authentication in front of it — even on your home network. Here's the tiered ladder, from a VPN to full SSO.
---

:::danger[Read this first]
Paddock ships with **no authentication of its own.** Anyone who can open the URL can
drive your agents — and those agents **run commands, hold your API and GitHub tokens,
and can read and write your repositories.** Treat access to Paddock like SSH access
to the host. **You must put an authentication layer in front of it — even if it never
leaves your home network.**
:::

## The threat model, briefly

A Paddock keeper is a real Claude Code session with tools. Someone who reaches an
unprotected instance can make it execute code, spend your Anthropic budget, exfiltrate
whatever the box can see, and push to any repo its token allows. "It's only on my LAN"
is not a defense — other devices, guests, and compromised IoT gadgets share that LAN.

So there are two jobs, and you should do **both**:

1. **Limit who can reach it** on the network.
2. **Authenticate every request** that does reach it.

Paddock helps with the first by **binding to loopback (`127.0.0.1`) by default** and
refusing to start on a public interface with auth disabled. Everything below is how you
add the second — all of it **at the edge**, with no password logic baked into Paddock.

## How Paddock reads identity

Paddock sits behind an authenticating reverse proxy and reads the identity that proxy
establishes. It has three auth modes (set with `PADDOCK_AUTH_MODE`; full details in
[Authentication](/configuration/authentication/)):

| Mode | What it does | Established by |
|------|--------------|----------------|
| `none` (default) | No identity check at all | Nothing — only safe when the network fully isolates it |
| `trusted-header` | Trusts an identity header (e.g. `X-Forwarded-User`) set by your proxy | A proxy that authenticates, then injects the header |
| `jwt` | Verifies a **signed JWT** against a JWKS URL and reads the user from a claim | An SSO/IdP that signs a token Paddock validates itself |

The key rule for `trusted-header`: it is only as safe as your proxy. The proxy **must**
authenticate the user *and* overwrite (never pass through) the identity header, and
Paddock must be reachable **only** via that proxy — otherwise anyone can forge the
header. `jwt` closes that gap by having Paddock verify the signature itself, so a
misconfigured proxy can't spoof a user.

## The ladder

Pick the lowest tier that matches how exposed the instance is and how many people use
it. Every tier keeps auth at the edge — none of them add a password to Paddock itself.

| | Tier | Auth mode | Good for |
|---|------|-----------|----------|
| **0** | [Network isolation](#tier-0--network-isolation) | `none` | Solo, one device or a VPN, nothing published |
| **1** | [Sidecar Basic Auth](#tier-1--sidecar-basic-auth) | `trusted-header` | A quick shared gate without running an IdP |
| **2** | [Cloudflare Access](#tier-2--cloudflare-access) | `jwt` | Publishing to the internet without self-hosting an IdP |
| **3** | [SSO forward-auth](#tier-3--sso-forward-auth-authentik--authelia) | `jwt` | Real accounts, MFA, one login across many apps |

### Tier 0 — network isolation

The safest thing you can do is make sure almost nothing can reach Paddock in the first
place. Keep it bound to localhost/LAN and reach it over a **VPN or overlay network** —
[Tailscale](https://tailscale.com), [WireGuard](https://www.wireguard.com), or an SSH
tunnel. Nothing is published to the internet; there is no login because there is no
public door.

- Leave `PADDOCK_AUTH_MODE=none` **only** if the instance is genuinely reachable by just
  you (a single device, or your tailnet). The moment more than one person — or one
  untrusted device — can reach it, move up a tier.
- Note: Paddock's **dev/preview servers** (the `pm`-managed ports agents use to show you
  a running app) **bypass Paddock's own request handling.** Keep those ports on the VPN
  too, and never expose them directly.

This is a floor you should keep even when you add a higher tier: isolate the network
*and* authenticate.

### Tier 1 — sidecar Basic Auth

The simplest way to add a real password without standing up an identity provider: run a
small reverse-proxy **sidecar that terminates TLS and enforces HTTP Basic Auth** in
front of Paddock. The proxy sets `X-Forwarded-User` from the authenticated user, and
Paddock runs in `trusted-header` mode so `req.user` reflects that person.

There's a turnkey recipe (Caddy and nginx variants) in
[**`paddock-deploy/auth-basic/`**](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic).
The Caddy version is only a few lines and gives you automatic HTTPS:

```caddyfile
paddock.example.com {
    basic_auth {
        # generate the hash with:  caddy hash-password
        you $2a$14$…bcrypt-hash…
    }
    reverse_proxy paddock:4000 {
        # Set the identity header from the authed user, overwriting any the
        # client sent — so it can't be forged.
        header_up X-Forwarded-User {http.auth.user.id}
    }
}
```

```bash
PADDOCK_AUTH_MODE=trusted-header
PADDOCK_AUTH_USER_HEADER=X-Forwarded-User
```

It's a **gate, not SSO**: one shared static credential, sent on every request, with no
MFA, no logout, and no lockout — and **HTTPS is mandatory**, because Basic Auth is just a
base64 header that TLS is the only thing protecting. Fine for a solo user or a small
trusted group behind a quick gate; step up for anything shared or exposed. One upside
over Tier 3: there's **no redirect flow**, so it sidesteps the service-worker-vs-redirect
friction the PWA can hit with a redirecting IdP.

### Tier 2 — Cloudflare Access

To publish Paddock to the internet **without self-hosting an IdP**, put
[Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) in front (via
a Cloudflare Tunnel, so you still don't open a port). Cloudflare authenticates the user
against your identity source and your Access policy, then injects a **signed JWT** on
every request. Paddock verifies that token itself:

```bash
PADDOCK_AUTH_MODE=jwt
PADDOCK_AUTH_JWT_HEADER=Cf-Access-Jwt-Assertion
PADDOCK_AUTH_JWKS_URL=https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs
PADDOCK_AUTH_JWT_ISSUER=https://<your-team>.cloudflareaccess.com
# Pin the audience to your Access application's AUD tag (strongly recommended):
PADDOCK_AUTH_JWT_AUDIENCE=<access-application-aud-tag>
```

Paddock reads the username from the token's `email` claim automatically. Because it
**validates the signature**, a request that didn't come through Cloudflare can't forge a
user — but still keep Paddock reachable only via the tunnel. You get real per-user
accounts, MFA, and policies without running any IdP yourself; the trade-off is a
dependency on Cloudflare.

### Tier 3 — SSO forward-auth (Authentik / Authelia)

For real accounts, MFA, and **one login across many self-hosted apps**, run your own SSO
provider — [Authentik](https://goauthentik.io) or [Authelia](https://www.authelia.com) —
and have your proxy delegate auth to it with `forward_auth`. This is how the author runs
it: Authentik as a shared IdP, fronting every app (Paddock included).

```caddyfile
paddock.example.com {
    # Hand every request to the SSO outpost first…
    reverse_proxy /outpost.goauthentik.io/* authentik-outpost:9000
    forward_auth authentik-outpost:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        # …and copy the identity it establishes onto the request.
        copy_headers X-Authentik-Username X-Authentik-Email X-Authentik-Groups X-Authentik-Jwt
    }
    reverse_proxy paddock:4000
}
```

Then point Paddock at that identity. Two options:

- **Trusted header** — simplest:
  ```bash
  PADDOCK_AUTH_MODE=trusted-header
  PADDOCK_AUTH_USER_HEADER=X-Authentik-Username
  ```
- **JWT** — strongest; Paddock verifies the SSO-signed token itself, so a
  misconfigured proxy can't spoof a user:
  ```bash
  PADDOCK_AUTH_MODE=jwt
  PADDOCK_AUTH_JWT_HEADER=X-Authentik-Jwt
  PADDOCK_AUTH_JWKS_URL=https://sso.example.com/application/o/paddock/jwks/
  ```

With SSO you get per-user accounts, MFA, and — if you run several apps — **one login for
all of them**. Because Paddock captures the authenticated user, this is also what makes
its per-user features (like read-state) meaningful.

## Protect the secrets too

Security isn't only the front door — it's also what the agents can reach:

- Keep `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` and any `gh` token in the
  **environment or a secrets file**, never committed to a repo.
- **Scope GitHub tokens to the minimum** — a fine-grained PAT limited to just the
  repos that instance should touch. If the box is ever compromised, that's the blast
  radius.
- Prefer delivering secrets at runtime (from a secrets manager into `/run`, tmpfs)
  over baking them into images or `.env` files on disk. See
  [A home-lab setup](/guides/home-lab/).

## Checklist

- [ ] Paddock's port is **not** on a public interface — only the proxy/tunnel is.
- [ ] You've picked a **tier** and it matches how exposed and shared the instance is.
- [ ] There is an **auth layer** on every path (a password at minimum; SSO ideally).
- [ ] `PADDOCK_AUTH_MODE` matches how your proxy establishes identity.
- [ ] `trusted-header`: the proxy **sets/overwrites** the header and is the only route in.
- [ ] `jwt`: `PADDOCK_AUTH_JWKS_URL` (and, ideally, issuer/audience) are pinned.
- [ ] Preview/`pm` ports are LAN/VPN-only or behind the same auth.
- [ ] Tokens are scoped-minimal and never committed.
