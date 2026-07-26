---
title: "Binding & network exposure"
description: "Paddock binds loopback by default and refuses to start open and unauthenticated. What changed in v0.44, who it breaks, and how to bind wider on purpose."
---

Paddock runs commands, holds your tokens, and can read and write your repositories.
Where it *listens* is therefore a security decision, not a convenience one — so since
v0.44 the defaults treat it that way.

:::danger[Breaking change in v0.44]
**The default bind host changed from `0.0.0.0` (all interfaces) to `127.0.0.1`
(loopback only).**

If you run Paddock **from source or the release tarball** and reached it from another
machine *without ever setting `HOST`*, upgrading to v0.44 or later will make it stop
answering — connections from anywhere but the box itself are refused. Nothing is
broken; it is bound where you didn't ask it to be reachable.

**The fix is one variable, plus a decision about auth** — see
[I upgraded and now I can't reach it](#i-upgraded-and-now-i-cant-reach-it) below.

You are **not** affected if you run a container image (it still binds `0.0.0.0` — see
[Containers](#containers-are-different)), or if you already set `HOST` /
`PADDOCK_HOST` explicitly. Only the *default* changed.
:::

## The two rules

### 1. The default is loopback

`HOST` defaults to `127.0.0.1`. A fresh `git clone` or tarball run is network-closed:
reachable from the box itself, from nothing else. You opt in to more.

Resolution order, highest first:

1. `HOST`
2. `PADDOCK_HOST` (an alias — `HOST` wins if both are set)
3. `host:` in [`paddock.config.yaml`](/configuration/config-file/)
4. `127.0.0.1`

### 2. Exposed **and** unauthenticated refuses to start

Binding a non-loopback address while `PADDOCK_AUTH_MODE=none` is the actual footgun,
and Paddock will not do it. Startup **fails closed** with a message naming your options
— the same fail-closed treatment as `jwt` mode without a JWKS URL.

| Bind host | Auth mode | Result |
|---|---|---|
| Loopback | anything | ✅ Starts |
| Non-loopback | `trusted-header` or `jwt` | ✅ Starts — no flag needed |
| Non-loopback | `none` | ❌ **Refuses to start** |
| Non-loopback | `none`, with `PADDOCK_DANGEROUSLY_ALLOW_OPEN` | ⚠️ Starts, logs a loud warning |

Note the second row: **binding widely is fine once you have real authentication.** The
guard isn't about exposure alone, it's about exposure *without* a way to tell who's
knocking.

### What counts as loopback

`localhost`, the whole IPv4 `127.0.0.0/8` range, the IPv6 loopback `::1`, and
IPv4-mapped loopback like `::ffff:127.0.0.1`. Bracketed forms (`[::1]`), surrounding
whitespace and casing are all normalised first.

**`0.0.0.0` and `::` are not loopback.** They mean *every* interface, which is exactly
the case the guard exists for.

## I upgraded and now I can't reach it

Pick whichever of these matches what you actually want:

**Put authentication in front of it (the right answer).** Set an auth mode and bind
wide. Nothing else is needed — no dangerous flag, no warning.

```bash
HOST=0.0.0.0
PADDOCK_AUTH_MODE=trusted-header   # behind a proxy that authenticates
```

See [Securing Paddock](/guides/securing/) for the ladder from a VPN through to SSO.

**Keep it on loopback and reach it through a proxy on the same box.** A reverse proxy
(Caddy, nginx, Traefik) listening publicly and forwarding to `127.0.0.1:4000` is a very
good posture: only the proxy is exposed, and it's the thing doing TLS and auth. Nothing
to change — this is the default.

**Reach it over a VPN or overlay network.** Bind loopback (or the tailnet interface)
and let WireGuard / Tailscale be the network boundary.

**You genuinely want an open, unauthenticated server.** Then say so out loud:

```bash
HOST=0.0.0.0
PADDOCK_AUTH_MODE=none
PADDOCK_DANGEROUSLY_ALLOW_OPEN=1
```

It boots, and logs a warning on every start telling you that anyone who can reach the
port can run code and spend your Claude tokens as you. The variable is named the way it
is on purpose. Accepts `1` / `true` / `yes`.

## Containers are different

The published images still set `HOST=0.0.0.0`, and that's correct — not an oversight.

Inside a container the **network namespace** is the isolation boundary. Docker cannot
reach `127.0.0.1` inside the container, so a loopback bind there would make the app
unreachable even from a deliberately-published port. The app also can't see the host's
publish posture from inside, so it's in no position to police it.

The safe posture for a container is therefore carried by **how you publish the port**,
not by the bind host:

```bash
# reachable only from the host, not the LAN
docker run -p 127.0.0.1:4000:4000 ghcr.io/edspencer/paddock:latest
```

The [`paddock-deploy`](https://github.com/edspencer/paddock-deploy/tree/main/docker)
recipes already do this. The app-level guard in this page is for bare-metal, tarball,
VM and systemd-in-LXC runs.

## See also

- [Securing Paddock](/guides/securing/) — authentication in front of Paddock, tier by tier.
- [Environment variables](/configuration/environment/#core--paths) — the `HOST` and `PADDOCK_DANGEROUSLY_ALLOW_OPEN` rows.
- [Deploying Paddock](/guides/deploying/) — where to run it in the first place.
