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

A Paddock chat is a real Claude Code session with tools. Someone who reaches an
unprotected instance can make it execute code, spend your Anthropic budget, exfiltrate
whatever the box can see, and push to any repo its token allows. "It's only on my LAN"
is not a defense — other devices, guests, and compromised IoT gadgets share that LAN.

So there are two jobs, and you should do **both**:

1. **Limit who can reach it** on the network.
2. **Authenticate every request** that does reach it.

Paddock helps with the first by **binding to loopback (`127.0.0.1`) by default** and
refusing to start on a public interface with auth disabled. Everything below is how you
add the second — all of it **at the edge**, with no password logic baked into Paddock.

:::note[This page is half the threat model]
Everything here is about **who can start a turn**. It says nothing about **what a turn
can do once it starts** — and that second axis is where the real blast radius lives. A
correctly-authenticated user and a scheduled trigger reach the same agent with the same
tools and the same credentials.

Read [**What your agents can do**](/guides/agent-capabilities/) for the capability side:
the default toolset (you cannot remove `Bash`), what you can and can't scope, and the
controls Paddock does not have. Then
[**Prompt injection and untrusted content**](/guides/untrusted-content/) for the case
where nobody breaks in and the agent follows instructions anyway.
:::

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
    reverse_proxy paddock:7233 {
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
    reverse_proxy paddock:7233
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

:::caution[Accounts are for attribution, not isolation]
SSO gives Paddock a *name* for each request. It does not partition anything. Every
authenticated user can drive every project, read every chat including yours, rewrite the
instance config, and start turns that run as the same OS user with the same credentials —
there is [no per-resource authorization](/reference/api/) and no role model. Per-user
read-state and provenance make it look more separated than it is; those are conveniences,
not authorization.

**Only give an account to someone you would give a shell on the host.** If you need two
trust levels, run two instances.
:::

## The `/mcp` Management API

Everything above puts auth **at the edge**. Paddock's external
[Management API](/reference/mcp/) is the one surface that must be handled the
other way round: it **authenticates itself**, and your edge gate has to get out
of its way.

Whichever tier you picked, the proxy must **exempt these two paths**:

| Path | Why |
|------|-----|
| `/mcp` | An MCP client sends its own `Authorization: Bearer <management token>`. A Basic Auth gate, a JWT-in-`Authorization` mode, or any header-based scheme **collides with it** — the client's credential is consumed or overwritten and token discovery breaks. |
| `/.well-known/oauth-protected-resource*` | Fetched **before** the client holds any credential. Gate it and discovery cannot happen at all. |

This is **universal**, not Authentik-specific. Basic Auth sidecars, SSO
forward-auth, Cloudflare Access, oauth2-proxy, plain header injection — all of
them need the exemption, for the same two reasons. And an SSO proxy has a second
failure mode: it answers an unauthenticated request with an **HTML login
redirect**, which no MCP client can follow and which breaks OAuth discovery
outright. Paddock's own gate always answers `401` with a `WWW-Authenticate`
challenge instead.

:::danger[Never add this exemption to an instance older than v0.46]
The Management API — and the authenticator that gates it — **shipped in v0.46.0**.
Before that release there is no management-API auth behind your proxy at all.

On a pre-v0.46 instance, exempting `/mcp` **removes the only gate in front of it**
and publishes an unauthenticated, turn-spawning endpoint to anyone who can reach
the proxy. A turn runs with `Bash`. That is remote code execution on the host,
reachable without a credential.

**Upgrade Paddock to v0.46.0 or later first, then change the proxy config.**
Never the other way round, and never "prepare" the exemption ahead of a rollout.

After v0.46 the ordering is safe by construction: `/mcp` returns **404** until you
have configured both `managementApi.clients` and `managementApi.publicUrl`, so the
exemption uncovers nothing until you deliberately turn the surface on.
:::

Turnkey recipes carry these exemptions already — see the `auth-basic/` (Caddy and
nginx) and Kubernetes recipes in
[**`paddock-deploy`**](https://github.com/edspencer/paddock-deploy). If you're
hand-rolling a proxy, add the two path exemptions using the same mechanism your
tier already uses for the health endpoints.

If you're setting the endpoint up for the first time, [**Connect Claude Code to
Paddock**](/guides/connect-claude-code/) walks the whole thing end to end, from
minting the token to the first `tools/list`.

Three more rules that stay yours even with the exemption in place:

- **Keep TLS in front — and name your terminator.** Paddock refuses a plaintext
  `/mcp` request from a non-loopback client (`403 insecure_transport`). Since
  **v0.48.1** ([#505](https://github.com/edspencer/paddock/pull/505), closing
  [#474](https://github.com/edspencer/paddock/issues/474)) it believes an
  `X-Forwarded-Proto: https` header **only from a peer you have trusted** —
  `managementApi.trustedProxies`, or `PADDOCK_MANAGEMENT_TRUSTED_PROXIES`. Left
  unset it defaults to loopback plus private address space, which is broad: on a
  shared Docker network or a flat LAN, anything on that network can still assert
  the header. **Set it to your actual proxy's address or CIDR** so the check
  means something. (`all` disables the guard entirely, with a loud warning;
  `none` is the strictest.) Even then it is defence in depth, **not** a guarantee
  the token never crosses the wire in cleartext — terminate TLS at the proxy and
  verify it yourself. (Related gotcha: a container's *published* port is not
  loopback from inside — Docker NATs the peer address — so an in-container
  plaintext test can `403` even though nothing left the host.)
- **Strip the identity header on the exempt route.** No auth ran there, so there
  is no authenticated identity to assert — *delete* `X-Forwarded-User` (or
  whatever `PADDOCK_AUTH_USER_HEADER` names) rather than pass a client-supplied
  one through. Paddock ignores the browser identity on `/mcp` anyway, but the
  invariant "this proxy is the only source of that header" should hold on every
  route, not only the challenged ones.
- **Treat a write-scoped token like a production secret.** The read-only default
  exists because any write scope starts turns. Full detail in the
  [Management API reference](/reference/mcp/).

:::danger[nginx: `auth_basic off` does **not** clear `$remote_user`]
The obvious nginx exemption — a `location /mcp` with `auth_basic off;` — opens a
**header-forgery hole**. nginx parses `Authorization` lazily and still populates
`$remote_user` from whatever the client sent, even where Basic Auth is disabled.
So a naive exemption that keeps `proxy_set_header X-Forwarded-User $remote_user;`
lets anyone forge an identity:

```sh
curl -u evil:anything https://paddock.example.com/mcp   # → X-Forwarded-User: evil
```

The fix is to route the identity through a variable that the exempt locations
reset to the empty string, rather than reading `$remote_user` directly. The
[`auth-basic/nginx`](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic)
recipe does exactly that — **use it rather than improvising**, and if you must
hand-roll, test with the `curl -u` above before you ship.
:::

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

:::danger[On `driveMode: batch`, a declared MCP credential is readable from `ps`]
If you declare MCP servers in the top-level **`mcpServers:`** block, the `env:VAR`
indirection keeps the resolved secret out of the config file, out of the boot log, out
of error messages and out of the Settings API. It does **not** keep it out of a command
line.

Under **`driveMode: batch`** herdctl's CLI runtime serialises the entire server
definition — resolved `env` values and `headers` included — into a single
`--mcp-config` **argv element**. A process argument is not private on Linux:
`/proc/<pid>/cmdline` is world-readable by default and `ps` prints it. So on `batch`,
any local user can read that token for the lifetime of every turn. This is observed
behaviour, not a theoretical concern — an integration test drives a real turn and
reads the token back out of the spawned process's argv.

The default **`driveMode: session`** is unaffected: it hands the same record to the SDK
in-process, and a spawned stdio server receives the value in its environment, where
`/proc/<pid>/environ` is owner-only.

Two things to check:

- **A single project pinning `driveMode: batch` reintroduces the exposure**, even on an
  instance whose default is `session`. Paddock warns at startup on a `batch` instance
  and notes it informationally otherwise, but it cannot see a per-project override
  coming.
- **On a multi-user box, `batch` plus a declared credential means every local account
  can read it.** If you cannot move off `batch`, do not declare a credential-bearing
  MCP server — attach it some other way, or accept that the secret is local-user-visible.

Paddock cannot fix this from its side; the fix is upstream. Full write-up:
[What Paddock touches on your machine](/guides/what-paddock-touches/).
:::

## What the instance takes from the host machine

Since v0.62 this is a readable config surface rather than something to infer.
Paddock always keeps its **own** Claude home under the data dir, and refuses to
start if that resolves to the operator's `~/.claude`. What it borrows is five
independent keys, four of which default to `own` (isolated):
`transcripts`, `instructions`, `hooks` and `mcpServers`. Only `credentials`
defaults to `host`, because reading a login writes nothing.

The two worth checking on a shared or exposed instance:

- **`claude.hooks`** — at `host`, the shell commands in the operator's
  `~/.claude/settings.json` execute inside Paddock turns.
- **`claude.mcpServers`** — at `host`, the MCP servers in the operator's
  `~/.claude.json` are attached to every keeper, with the tool allow-list widened
  to match. That is inherited capability, and belongs in the same mental bucket
  as `browserMcp`.

Full detail: [What Paddock touches on your
machine](/guides/what-paddock-touches/).

## Checklist

- [ ] Paddock's port is **not** on a public interface — only the proxy/tunnel is.
- [ ] You've picked a **tier** and it matches how exposed and shared the instance is.
- [ ] There is an **auth layer** on every path (a password at minimum; SSO ideally).
- [ ] `PADDOCK_AUTH_MODE` matches how your proxy establishes identity.
- [ ] `trusted-header`: the proxy **sets/overwrites** the header and is the only route in.
- [ ] `jwt`: `PADDOCK_AUTH_JWKS_URL` (and, ideally, issuer/audience) are pinned.
- [ ] Preview/`pm` ports are LAN/VPN-only or behind the same auth.
- [ ] Tokens are scoped-minimal and never committed.
- [ ] If you use the Management API: the proxy exempts `/mcp` **and**
      `/.well-known/oauth-protected-resource*`, and the instance is **v0.46.0 or
      later**.
- [ ] Management-API client tokens live in the **environment** (`auth.ref:
      env:…`), never inline in `paddock.config.yaml`.
- [ ] If you declare `mcpServers:` with an `env:VAR` credential, the instance —
      **and every project on it** — is on `driveMode: session`, not `batch`.
- [ ] `/mcp` is reached over **real TLS** you verified — not merely a request
      Paddock's `X-Forwarded-Proto` check accepted.
- [ ] `managementApi.trustedProxies` **names your actual TLS terminator**, rather
      than inheriting the default private-address-space list.
- [ ] nginx exemptions reset the forwarded-identity variable to `""`
      (`auth_basic off` alone still lets `$remote_user` be forged).
- [ ] You have read [What your agents can do](/guides/agent-capabilities/) and
      [Untrusted content](/guides/untrusted-content/) — authentication bounds who
      starts a turn, not what it can reach.
