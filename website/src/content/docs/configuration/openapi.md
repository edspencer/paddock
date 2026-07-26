---
title: "OpenAPI & Swagger"
description: "Turn on the built-in Swagger UI, understand its mode-aware Authorize button, and know how it relates to the published API reference."
---

Paddock can serve a **Swagger UI for its own HTTP API**, generated from the server's
route schemas. It is **off by default** — publishing a map of your whole API surface
is a deliberate choice, not something an instance should do on its own.

There are two different things called "the API reference", and it's worth separating
them up front:

| | [The published reference](/api/) | This instance's Swagger UI |
|---|---|---|
| Where | `/api/` on this docs site | `/open-api` on your own Paddock |
| Which version | the latest release | exactly the code *you* are running |
| Auth shown | bearer (JWT), always | whatever **your** auth mode is |
| "Try it out" | disabled — it's a static page | works, against your live instance |
| Needs | nothing | `PADDOCK_OPENAPI_ENABLED` |

Read the published one to learn the API. Turn on your own when you want to *call* it.

## Turning it on

```bash
PADDOCK_OPENAPI_ENABLED=1
```

Or in `paddock.config.yaml`:

```yaml
openapi:
  enabled: true
  path: /open-api        # optional
```

| Variable | Default | What it does |
|----------|---------|--------------|
| `PADDOCK_OPENAPI_ENABLED` | `false` | Mounts the whole surface. Accepts `1` / `true` / `yes` / `on`. |
| `PADDOCK_OPENAPI_PATH` | `/open-api` | Route prefix for the UI. Normalised to a leading slash and no trailing slash. |

When it's off, none of these routes exist at all — there is nothing to 404 through.

## What you get

Restart, and the surface appears:

- **`/open-api`** — the Swagger UI itself, styled with your instance's
  [branding](/configuration/environment/#branding-per-instance) (logo, favicon, and the
  accent colour on the topbar trim).
- **`/open-api/json`** — the raw OpenAPI 3.0 document.
- **`/open-api.json`** — an alias for the same document, because that's the path people
  reach for first. Both follow `PADDOCK_OPENAPI_PATH` if you move the prefix.
- **A "Swagger API" link in the sidebar**, below Settings, opening in a new tab. It only
  renders when the surface is enabled, so the sidebar of a plain instance is unchanged.

The document is *derived from the code*: every REST route attaches a Fastify `schema`
(tags, summary, params, body, responses) and `@fastify/swagger` collects them into a
live document at boot. Add a route with a schema and it shows up here with no separate
step — which is exactly why the hand-maintained REST tables that used to live in these
docs were retired.

:::note[Live chat is not in the spec]
Sending a message, streaming the reply, tool-call events, cancel, slash-commands and
the live queue are **WebSocket**, not REST — see the
[WebSocket protocol](/reference/websocket/). The `/ws` upgrade and the
[`/mcp` Management API](/reference/mcp/) routes are both deliberately excluded from the
document (a Swagger "Try it out" against either would only ever fail), so the spec is
the HTTP surface and nothing else.
:::

## The Authorize button reflects *your* auth mode

Paddock has no login of its own — [authentication](/configuration/authentication/)
happens at the edge — so a single fixed security scheme would be wrong for most
instances. The document instead advertises whichever scheme matches the mode this
instance is actually running:

| `PADDOCK_AUTH_MODE` | Scheme in the spec |
|---|---|
| `jwt`, with the token in `Authorization` (the default header) | **bearer** (`http` / `bearer`, format JWT) |
| `jwt`, with the token in some other header | **apiKey** in that header |
| `trusted-header` | **apiKey** in your configured identity header (`PADDOCK_AUTH_USER_HEADER`, default `X-Forwarded-User`) |
| `none` | no scheme and no requirement — every request is anonymous |

The Authentication paragraph in the document's description is rewritten to match, so
the docs never describe a mode you aren't running.

:::tip[Behind a proxy, you probably don't need to Authorize at all]
When the Swagger UI is served **by the Paddock instance itself**, on the same origin,
behind your authenticating proxy, a **Try it out** call is a same-origin XHR that
already carries your browser's SSO session. The proxy authenticates it and injects the
identity exactly as it does for the app — nothing to paste.

The **Authorize** button is for the explicit-token path: calling from a different
origin, a programmatic client, or testing `jwt` mode without the proxy in front.
:::

## Exposure

Enabling this publishes a complete map of the HTTP surface — every route, every
parameter, every response shape — to anyone who can load the page. It sits behind the
same auth as the rest of the app, so on a properly
[secured](/guides/securing/) instance that means "anyone who can already log in". On an
instance running `PADDOCK_AUTH_MODE=none`, it means anyone who can reach the port.

That's the whole reason the flag defaults off. It is a convenience for operators and
integrators, not something to leave on by default.

## Regenerating the published spec

The [published reference](/api/) is served from a spec file committed to the repo at
`openapi-site/open-api.json`, because the docs site is a static build with no Paddock
server behind it. Since the spec is derived from the live route schemas, it is
regenerated rather than edited:

```bash
npm run build:server              # compile the server
node scripts/dump-openapi.mjs     # writes openapi-site/open-api.json
```

The dump boots the real app in-process against a throwaway temp directory — no port is
bound and no real project data is touched — then reads the live document. It pins
`PADDOCK_AUTH_MODE=jwt` so the published reference advertises the bearer Authorize
flow, which is the mode most real deployments run.

The release workflow runs this after cutting a version and commits the result, so the
published reference tracks the newest release without anyone remembering to do it. Run
it by hand only if you want to see a spec change before it ships.
