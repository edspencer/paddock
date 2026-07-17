---
title: Securing Paddock
description: Paddock has no built-in login. Put authentication in front of it — even on your home network. Here's how.
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

## 1. Limit reachability

- **Don't expose it to the internet** unless you have a real reason. The safest setup
  is Paddock bound to localhost/LAN and reached over a **VPN or overlay network**
  (WireGuard, Tailscale, etc.).
- If you *do* publish it, publish **only the reverse proxy**, never Paddock's port.
- Note: Paddock's built-in **dev/preview servers** (the `pm`-managed ports agents use
  to show you a running app) **bypass Paddock's own request handling** — keep those
  ports LAN-only or behind the same auth, and never expose them directly.

## 2. Authenticate every request

Paddock is designed to sit behind an authenticating reverse proxy and read the
identity that proxy establishes. It has three auth modes (set with
`PADDOCK_AUTH_MODE`; full details in [Authentication](/configuration/authentication/)):

| Mode | What it does | Use when |
|------|--------------|----------|
| `none` (default) | No identity check at all | Only if Paddock is **fully isolated** (VPN-only) *and* you still add a proxy password |
| `trusted-header` | Trusts an identity header (e.g. `X-Authentik-Username`) set by your proxy | Your proxy authenticates the user and injects a header |
| `jwt` | Verifies a **signed JWT** from your identity provider against a JWKS URL | You run an SSO/IdP and want Paddock to validate tokens itself (strongest) |

The key rule for `trusted-header`: it is only as safe as your proxy. The proxy **must**
authenticate the user *and* overwrite (never pass through) the identity header, and
Paddock must be reachable **only** via that proxy — otherwise anyone can forge the
header.

## The simplest thing that's safe: Caddy + a password

Even at home, put a password in front. [Caddy](https://caddyserver.com) makes this a
few lines and gives you automatic HTTPS:

```caddyfile
paddock.example.com {
    basic_auth {
        # generate the hash with:  caddy hash-password
        you $2a$14$…bcrypt-hash…
    }
    reverse_proxy localhost:4000
}
```

That's the floor, not the ceiling: HTTP basic auth is a single shared password with no
MFA and no per-user accounts. It's fine for a solo user on a private network; it is not
how you'd protect anything shared or exposed.

## Better: single sign-on in front (how the author does it)

For real accounts, MFA, and one login across many self-hosted apps, put an **SSO
provider** in front — [Authentik](https://goauthentik.io) or
[Authelia](https://www.authelia.com) — and have Caddy delegate auth to it with
`forward_auth`. The author runs Authentik as a shared IdP and fronts every app
(Paddock included) with it:

```caddyfile
paddock.example.com {
    # Hand every request to the SSO outpost first…
    reverse_proxy /outpost.goauthentik.io/* authentik-outpost:9000
    forward_auth authentik-outpost:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        # …and copy the identity it establishes onto the request.
        copy_headers X-Authentik-Username X-Authentik-Email X-Authentik-Groups X-Authentik-Jwt
    }
    reverse_proxy localhost:4000
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

With SSO you get per-user accounts, MFA, and — if you run several apps — **one login
for all of them**. Because Paddock captures the authenticated user, this is also what
makes its per-user features (like read-state) meaningful.

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

- [ ] Paddock's port is **not** on a public interface — only the proxy is.
- [ ] There is an **auth layer** (password at minimum; SSO ideally) on every path.
- [ ] `PADDOCK_AUTH_MODE` matches how your proxy establishes identity.
- [ ] `trusted-header`: the proxy **sets/overwrites** the header and is the only route in.
- [ ] Preview/`pm` ports are LAN-only or behind the same auth.
- [ ] Tokens are scoped-minimal and never committed.
