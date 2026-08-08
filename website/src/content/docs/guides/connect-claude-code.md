---
title: Connect Claude Code to Paddock
description: "The simplest end-to-end path from nothing to a working read-only MCP connection: mint a token, set one environment variable, add six lines of YAML, and run claude mcp add. No proxy, no secrets manager, no Kubernetes."
---

:::note[This is the outbound direction]
This page connects **your terminal `claude` to a Paddock instance**, so a session
on your laptop can read what the instance is doing. If what you want is the
other direction — letting a Paddock instance use the transcripts, login,
`CLAUDE.md` or MCP servers that your Claude Code already has on this machine —
that is the [`claude:` config block](/configuration/config-file/#claude--what-this-instance-shares-with-your-claude-code),
summarised in [What Paddock touches on your
machine](/guides/what-paddock-touches/). Nothing on this page affects it.
:::

At the end of this guide, a `claude` session on your laptop can list the
projects on your Paddock instance, list their chats, and read a transcript —
and **cannot** start a turn, send a message, or create anything.

That last part is the point. This is the deliberately boring, read-only version,
and it's the one you should set up first.

:::danger[Any write scope is remote code execution on the host]
`create_chat`, `send_message`, `fork_chat`, `fork_chat_batch`, `run_trigger` and
`set_trigger` **start turns** — and Claude runs with `Bash` and `Write`.
**`create_project` *and* `promote_project`** each clone a git URL the caller supplies;
`promote_project` is the easy one to overlook, because `repo` is its only required
argument, so it is the same clone under a different name. `archive_chat`,
`unarchive_chat` and `remove_trigger` don't execute code, but they do mutate state a
read-only client has no business touching. Granting any of these to a client is
granting code execution on the machine Paddock runs on.

This guide never grants one. The whole safety story is that a client configured
with **no `scope` block** is read-only, so the way to stay safe is to not write a
`scope` block. Come back to the [Management API
reference](/reference/mcp/#scopes-and-policy) when you actually need a write
verb, and treat the token that carries it as a production secret.
:::

## What you need

- **Paddock v0.46.0 or newer.** The `/mcp` endpoint and the authenticator that
  gates it shipped in 0.46.0. On anything older this doesn't exist.
- **A way to edit `paddock.config.yaml`** on the instance, and to **set an
  environment variable** for the Paddock process.
- **Claude Code on your laptop** — the `claude` CLI.
- **A way to reach the instance over TLS**, or a way to reach it over loopback.
  Read the next section before you start; it's the one decision that changes the
  rest.

You do **not** need a secrets manager, a reverse proxy, an identity provider, or
a container orchestrator. None of them appear below.

## First, decide how you'll reach it

Paddock refuses a plaintext `/mcp` request from a **non-loopback** client with
`403 insecure_transport`. The endpoint carries a bearer token in a header, so
this is deliberate — and it's the step people hit last and debug longest. Settle
it first.

Three routes, simplest first. Pick one and remember which; step 3 and step 5
both depend on it.

### Route A — over an SSH tunnel (no proxy at all)

If you already have SSH to the box, this is the least moving parts of anything
in this guide, and it is genuinely secure: SSH encrypts the hop, and Paddock
sees a loopback client because `sshd` connects to the port from the host itself.

```sh
# on your laptop, in a terminal you leave open
ssh -N -L 7233:127.0.0.1:7233 you@your-paddock-host
```

Your instance is now at `http://127.0.0.1:7233` **from the laptop**, and
`http://127.0.0.1:7233/mcp` is a legitimate plaintext URL — nothing crosses the
network in the clear.

The trade-off is that the tunnel has to be up for the connection to work; a
`claude` session started without it will just fail to connect.

### Route B — a real hostname with automatic HTTPS

For a permanent connection you want real TLS. The
[`auth-basic/caddy`](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic)
recipe in `paddock-deploy` is the shortest path to it: point a DNS name at the
box, set `SITE_ADDRESS` to that name, and Caddy provisions a Let's Encrypt
certificate on its own. The recipe already exempts `/mcp` and
`/.well-known/oauth-protected-resource*` from its Basic Auth challenge, which
you will need — see Route C.

Any TLS-terminating proxy works. Caddy is suggested because it needs the least
configuration to get a valid certificate.

### Route C — you already run a proxy or an edge login

Then you have one extra job, and MCP cannot work until it's done: **exempt
`/mcp` and `/.well-known/oauth-protected-resource*` from your edge auth.**

Basic Auth collides with MCP head-on — the proxy challenges with the
`Authorization` header, and the MCP client puts its own `Authorization: Bearer …`
in that same header, so there is no password that is also a valid MCP
credential. An SSO proxy fails differently and just as fatally: it answers with
a `302` to an HTML login page, which no MCP client can follow.

Exempting is safe because Paddock authenticates `/mcp` itself, independently of
`PADDOCK_AUTH_MODE` and of your proxy. Don't duplicate the recipes here — see
[Securing Paddock → The `/mcp` Management API](/guides/securing/#the-mcp-management-api)
for the rules (including a **deploy-ordering hazard** you should read before
touching a proxy config), and `paddock-deploy`'s
[`auth-basic/`](https://github.com/edspencer/paddock-deploy/tree/main/auth-basic)
and [`kubernetes/`](https://github.com/edspencer/paddock-deploy/tree/main/kubernetes)
recipes for configurations that carry the exemption already.

:::caution[Don't "fix" a `403` with `X-Forwarded-Proto: https`]
Paddock treats that header as proof of TLS termination, but since **v0.48.1** it
only believes it from a peer listed in `managementApi.trustedProxies`
(`PADDOCK_MANAGEMENT_TRUSTED_PROXIES`) — the header alone is no longer enough
from anywhere ([#474](https://github.com/edspencer/paddock/issues/474), fixed by
[#505](https://github.com/edspencer/paddock/pull/505)). Unset, the trust list
defaults to loopback plus the private address space (link-local and
unique-local), **not** every peer: a public-addressed client sending the header
is refused. `all` restores the old believe-anyone behaviour and boots with a
loud warning; `none` is the strictest setting.

So the fix is not to add the header by hand — it's to **name your actual TLS
terminator** in `trustedProxies`, which is also what turns the check from a
footgun-preventer into a control. Adding it from a client that merely happens to
sit in private address space still "works" under the default list, and that is
the habit to avoid: it stops working the moment you tighten the list, and it
tells you nothing about whether your token crossed the network in clear. See
[the `/mcp` reference](/reference/mcp/#which-peers-are-believed) for the full
trust-list semantics and
[the config file](/configuration/config-file/) for where to set it.

Sending the header by hand is still defensible as a one-off same-host smoke test
— for instance from inside a container, where a *published* port is not loopback
because Docker NATs the peer address. **Never send it across a network**, and
never bake it into a client config.
:::

## 1. Mint a token

On any machine with `openssl`:

```sh
printf 'pdk_%s_%s\n' myinstance "$(openssl rand -hex 24)"
```

Replace `myinstance` with a short name for this instance; you'll repeat it as
`instanceId` in step 3. The `pdk_<instanceId>_` prefix **binds the token to this
instance** — copy it to a second Paddock and it is refused there even though the
bytes are identical — and gives secret scanners something to match on. An
unprefixed token still authenticates, but logs a warning that it isn't bound.

:::caution[No underscores in the instance name]
Paddock reads the embedded instance id as everything between `pdk_` and the
**next `_`**. So `myinstance` is fine and `my-paddock` is fine, but
`my_paddock` is not: the token `pdk_my_paddock_<secret>` parses as instance
`my`, which never matches, and **every request 401s** with nothing but a boot
warning to explain it. Use hyphens.
:::

Tokens shorter than 24 characters are dropped with a warning, measured across
the *whole* string including the prefix. `openssl rand -hex 24` gives you 48
characters of secret on its own, so you're well clear.

Keep the output somewhere you can paste from twice — into the instance's
environment in step 2, and into `claude mcp add` in step 5. It is never
recoverable from Paddock afterwards.

## 2. Put the token in the instance's environment

**Not in the YAML.** `paddock.config.yaml` is git-tracked and editable from the
instance Config screen, so a literal `token:` or `secret:` in it is a **hard
config error** — Paddock rejects the client rather than accepting a secret
you're about to commit. The config only ever holds the *name* of an environment
variable.

Set `PADDOCK_MCP_TOKEN_LAPTOP` wherever your setup passes environment to the
Paddock process:

```ini title="systemd — /etc/paddock.env, referenced by EnvironmentFile="
PADDOCK_MCP_TOKEN_LAPTOP=pdk_myinstance_1a2b3c…
```

```sh title="docker run"
docker run -e PADDOCK_MCP_TOKEN_LAPTOP=pdk_myinstance_1a2b3c… …
```

```yaml title="docker compose — pass it through from .env, don't inline it"
services:
  paddock:
    environment:
      PADDOCK_MCP_TOKEN_LAPTOP: "${PADDOCK_MCP_TOKEN_LAPTOP:-}"
```

The variable name is entirely yours — it just has to match the `ref:` in step 3.
One variable per client. `paddock-deploy`'s
[`docker/`](https://github.com/edspencer/paddock-deploy/tree/main/docker) recipe
ships with exactly this line already wired through from `.env`.

## 3. Add the `managementApi` block

Six lines in `paddock.config.yaml`:

```yaml
managementApi:
  instanceId: myinstance
  publicUrl: https://paddock.example.com
  clients:
    laptop:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_LAPTOP
      # No `scope:` block — that is what makes this client read-only.
```

Three things to get right:

- **`publicUrl` is mandatory** as soon as `clients` is set. Omit it, or write
  something that fails validation, and Paddock **discards every client** — so
  `/mcp` stays **404**. That 404 is the single most common reason this doesn't
  work, and the config error naming the field is in the log.

  Paddock deliberately refuses to derive this from the `Host` header: that
  header is attacker-controlled, and behind a TLS-terminating proxy the derived
  scheme would be wrong anyway. So state the real origin. A merely *inaccurate*
  value that still validates won't break a bearer-token client — it's only used
  to build the OAuth discovery document, which isn't published here — but it is
  a typo that stays silently wrong, so get it right while you're looking at it.
  - On **Route A** (SSH tunnel) that value is `http://127.0.0.1:7233` —
    plain `http` is accepted for `localhost`, `127.0.0.1` and `::1`, and only for
    those. Any other host must be `https` or the management API refuses to start.
  - On **Routes B and C** it's your real external origin,
    `https://paddock.example.com`. No trailing slash, no query string, no
    fragment.
- **`instanceId` must match** the one you baked into the token in step 1, or the
  token is refused.
- **`laptop` is the client id.** It's yours to choose; it's what gets logged and
  stamped as provenance. The token itself never is.

Leave `authorizationServers` out. It only advertises OAuth issuers, and OAuth
isn't shipped — see [What this doesn't cover](#what-this-doesnt-cover).

## 4. Restart, and read the log line

Restart Paddock and look for one of these two lines:

```text
management API: /mcp enabled (self-authenticated — independent of PADDOCK_AUTH_MODE and of any proxy)
```

It carries the enabled client ids and the `instanceId` as structured fields.
That's success. Otherwise:

```text
management API: /mcp disabled (no managementApi.clients configured) — the endpoint 404s
```

:::caution[That "no clients configured" line lies a little]
It prints whenever the resolved client list came out empty — **including when
your `clients:` block is right there in the file** but `publicUrl` was missing
or invalid, because that discards every client. If you're staring at it with a
client plainly configured, the real reason is on a **separate `error`-level line
just above**. Read that one.
:::

Every rejection is logged with the reason, at `error` for something malformed
(an inline secret, an unknown `auth.type`, a missing or non-`env:` `ref`, a bad
`publicUrl`) and at `warn` for a client whose credential simply wouldn't resolve
— env var unset, blank, or under 24 characters. Read the message; it names the
field.

A misconfigured management API never takes the instance down. It fails closed
and the rest of Paddock carries on, which is why you have to actually look at
the log rather than assume a clean boot means a working endpoint.

## 5. Add the server to Claude Code

On your laptop:

```sh
claude mcp add --transport http --scope user paddock \
  https://paddock.example.com/mcp \
  --header "Authorization: Bearer pdk_myinstance_1a2b3c…"
```

On Route A, the URL is `http://127.0.0.1:7233/mcp` instead, and the tunnel from
step 0 has to be up.

Three details that each cost somebody an afternoon:

- **Use `--scope user` or `--scope local`.** A `--scope project` server needs
  interactive approval before it will connect.
- **`--transport http` is not optional.** An entry with a `url` but no type is
  treated as a **stdio** server and fails. The CLI writes `"type": "http"` for
  you; hand-edited JSON must include it.
- **A configured `Authorization` header and OAuth are mutually exclusive.** If
  the header is rejected, the client reports a failed connection — it does not
  fall back to anything.

The token lands in your shell history here. Clear it, or pass it via a variable
you've already exported, if that matters to you.

## 6. Verify

Start `claude` and check the tools it now has. You should see exactly four:

```text
list_projects   list_chats   read_chat   list_triggers
```

and you should **not** see `create_chat` or `send_message`. Out-of-scope tools
are hidden rather than offered-and-refused, so their absence is the confirmation
that the read-only default took effect. If you see write verbs, you have a
`scope` block you didn't mean to write.

To check the endpoint without a client at all:

```sh
curl -sS -X POST https://paddock.example.com/mcp \
  -H "Authorization: Bearer $PADDOCK_MCP_TOKEN_LAPTOP" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Two things about that command surprise people:

:::note[The `Accept` header is required, and the reply is an SSE stream]
Omit `Accept: application/json, text/event-stream` and you get **`406 Not
Acceptable`** — `Client must accept both application/json and
text/event-stream` — which reads at a glance like an auth failure and sends
people back to re-check their token. It isn't one; the streamable-HTTP
transport may answer either way, so a client has to accept both.

And a **success** doesn't print bare JSON. The response comes back
`content-type: text/event-stream`, framed:

```text
event: message
data: {"result":{"tools":[{"name":"list_projects", …
```

That is a `200` and it is working. Pipe it through `grep '^data: '` if you want
to feed it to `jq`.
:::

## Troubleshooting

| Symptom | Cause |
|---|---|
| **`404`** `{"error":"not found"}` | The management API is off. No `clients`, or no `publicUrl`, or `publicUrl` failed validation — the log line from step 4 says which. |
| **`403`** `insecure_transport` | Plaintext from a non-loopback client. Use TLS (Route B/C) or a tunnel (Route A). Do **not** add `X-Forwarded-Proto`. |
| **`401`** + `WWW-Authenticate: Bearer` | Token missing, malformed, or matching no client. Check the `instanceId` in the token matches the config, and that the env var actually reached the process. |
| **`406`** | No `Accept: application/json, text/event-stream`. Not an auth problem. |
| **`405`** + `Allow: POST` | You sent `GET` or `DELETE` *with a valid token*. `/mcp` is `POST`-only; it refuses rather than hanging on a stream that never emits. Without a token the same request is a `401` — the auth gate runs first — so opening `/mcp` in a browser tells you nothing useful. |
| **`302`** to a login page | Your edge proxy is gating `/mcp`. Exempt it — Route C. |
| **`401` from a Basic Auth realm** | Same thing: the proxy consumed the `Authorization` header before Paddock saw it. |
| Connects, but **no tools** | The client's credential resolved but every operation is out of scope. A `scope` block with an empty `allow` grants nothing. |
| Connects, but **write tools appear** | You have a `scope` block granting them. Re-read the warning at the top of this page. |
| `403` from **inside a container**, over loopback | A published port is not loopback from inside — Docker NATs the peer address. Test from the host instead. |

## What this doesn't cover

- **OAuth.** It isn't implemented
  ([#473](https://github.com/edspencer/paddock/issues/473)). Static bearer tokens
  are the only credential that works today. Paddock publishes an RFC 9728
  discovery document only when you configure `authorizationServers`, and
  deliberately publishes nothing otherwise rather than emit a document the MCP
  spec would call invalid — a client holding a static token never performs
  discovery, so nothing is lost.
- **Write access.** Covered, with its full risk framing, in the
  [Management API reference](/reference/mcp/#scopes-and-policy).
- **Per-project scoping**, `deny` rules and `maxSpawnDepth` — same place.

## See also

- **[Management API (MCP)](/reference/mcp/)** — the complete reference: response
  matrix, scope semantics, discovery document, token binding.
- **[Securing Paddock](/guides/securing/#the-mcp-management-api)** — the edge
  exemption, and the deploy-ordering hazard.
- **[Self-management MCP](/reference/self-mcp/)** — the same tools as Claude sees
  them from *inside* an instance.
- **[`paddock-deploy`](https://github.com/edspencer/paddock-deploy)** — Docker,
  Proxmox, Kubernetes and Basic-Auth recipes, all carrying the `/mcp` exemption.
