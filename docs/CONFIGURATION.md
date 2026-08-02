# Configuration reference

Paddock is configured from the **environment**, optionally layered over a
**YAML instance-config file** — precedence **file < env** (the file provides the
base, environment variables override it). Every setting is resolved once at
startup (`packages/server/src/config.ts`), normalised, and frozen. This page is
the canonical list of every variable the server reads, its default (taken from
the code, not guessed), and what it does.

Environment-only remains fully supported and is the default: with no file
present, behaviour is exactly as it was before the loader existed. For a runnable
starting point, copy [`.env.example`](../.env.example) to `.env` and adjust.
Authentication is summarised below but documented in full in [AUTH.md](../AUTH.md).

## Instance-config file (YAML)

An optional YAML file provides the **base layer** for every setting below; any
`PADDOCK_*` (or plain, e.g. `PORT`) environment variable still wins over the
file value it shadows. This is the same file the schedule and (later) hook
declarations will live in, and it matches the repo's YAML house style
(`project.yaml`, the generated `herdctl.yaml`).

- **Location.** `PADDOCK_CONFIG` (an explicit path) if set, otherwise
  `<PADDOCK_DATA_DIR>/paddock.config.yaml`.
- **Absent file → no-op.** If the default file doesn't exist, Paddock is
  env-only exactly as before. (An explicit `PADDOCK_CONFIG` that points at a
  *missing* file is a misconfiguration and fails startup with a clear error, as
  does a present-but-malformed file — a parse error, or a top-level list/scalar
  instead of a mapping.)
- **Shape.** Keys mirror the resolved config: top-level scalars (`port`, `host`,
  `logLevel`, `keeperDriveMode`, `maxSpawnDepth`, `browserMcp`,
  `sweepMinIntervalMs`, `selfMcpEnabled`, …), the `models` allow-list array, plus
  nested sections `auth`,
  `brand`, `transcription`, `gitAuthor`, and `managementApi` (the last is
  file-first — only its `trustedProxies` has an env equivalent). Unknown keys are
  ignored. Each value is coerced through the same parsing an env value would get,
  so the same default/validation rules (below) apply.

```yaml
# <data>/paddock.config.yaml — every value here is overridable by its env var
port: 4000
logLevel: info
keeperDriveMode: session
auth:
  mode: jwt
  jwksUrl: https://idp.example/jwks
brand:
  name: Homelab
  accent: "#3c6ec2"
gitAuthor:
  name: Paddock
  email: paddock@localhost
```

## How values are parsed

Two helpers do almost every read:

- **`envOr(name, fallback)`** — the raw (untrimmed) value if non-blank, else the
  literal fallback. Only the blank *check* is trimmed; the returned value keeps any
  surrounding whitespace.
- **`envOpt(name)`** — the trimmed value, or unset (`undefined`) when blank.

Consequences worth knowing:

- **Blank is unset.** A whitespace-only value (`PADDOCK_X=""`) yields the default,
  not an empty string.
- **Booleans** accept `1` / `true` / `yes` (case-insensitive) as true — *except*
  `PADDOCK_NATIVE_PROMPT`, which is on by default and only `0` / `false` /
  `no` turns it off.
- **Unknown enum values fall back to the default** rather than failing startup
  (e.g. an unrecognised `PADDOCK_AUTH_MODE` becomes `none`).
- **Paths** are resolved to absolute and canonicalised (symlinks resolved) so
  Claude Code session discovery can find transcripts.

---

## Core / paths

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_CONFIG` | `<data>/paddock.config.yaml` | no | Path to the optional [YAML instance-config file](#instance-config-file-yaml) (base layer; env overrides it). When set explicitly, a missing file fails startup; unset, an absent default file is a no-op. |
| `PADDOCK_DATA_DIR` | `./data` | no | Data root. **All paths below default to subdirectories of this** — set it and everything cascades. Holds projects, generated herdctl config, and state. |
| `PADDOCK_PROJECTS_DIR` | `<data>/projects` | no | Root that contains per-project directories (each is an agent's working dir). |
| `PADDOCK_SCRATCH_DIR` | `<data>/scratch` | no | **Legacy.** Where one-off ("scratch") chats lived before #516 Phase 6 retired them. No agent runs here and nothing reads it any more; the setting survives so an existing env/config file doesn't fail validation, and so any old transcripts stay findable by hand at `<scratchDir>/.chats`. They are **not** migrated and no longer listed. |
| `PADDOCK_STATE_DIR` | `<data>/.herdctl` | no | herdctl state directory. |
| `PADDOCK_HERDCTL_CONFIG` | `<data>/herdctl.yaml` | no | Path to the generated `herdctl.yaml` the FleetManager loads (Paddock owns/regenerates it). |
| `PADDOCK_WEB_DIST` | `packages/web/dist` | no | Built SPA served in production (resolved relative to the server module). |
| `PORT` | `4000` | no | HTTP/WS listen port. |
| `HOST` | `127.0.0.1` | no | Bind host. Loopback by default (#435) so a fresh source/tarball run is network-closed. The container images set `HOST=0.0.0.0` — the network namespace is their boundary. `PADDOCK_HOST` is an accepted alias. |
| `PADDOCK_DANGEROUSLY_ALLOW_OPEN` | — | no | Permits binding a non-loopback host while `PADDOCK_AUTH_MODE=none`. Without it that combination **refuses to start**; see [AUTH.md](../AUTH.md). Boots with a loud warning when set. |
| `PADDOCK_MANAGEMENT_TRUSTED_PROXIES` | `loopback, linklocal, uniquelocal` | no | Peers whose `X-Forwarded-Proto` the `/mcp` plaintext guard believes. IPs, CIDRs, `loopback`/`linklocal`/`uniquelocal`, or `none`/`all`. Overrides `managementApi.trustedProxies`; see [Management API](#management-api-mcp-external-callers). |
| `CLAUDE_HOME` | `~/.claude` | no | Claude home used for session/transcript discovery. |

> **`PADDOCK_CONFIG__*` is not implemented.** There is no generic
> `PADDOCK_CONFIG__foo__bar` → nested-herdctl-key override mechanism in this tree.
> (Not to be confused with `PADDOCK_CONFIG`, above — the single-underscore var is
> the path to the YAML instance-config file. The similarly-named
> `window.__PADDOCK_CONFIG__` is a browser global the server injects into
> `index.html` to carry branding to the SPA — not an env var.)

## Authentication

Provider-agnostic; the default (`none`) is fully open. See **[AUTH.md](../AUTH.md)**
for modes, provider examples, and secret handling — this table is only the knobs.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_AUTH_MODE` | `none` | no | `none` \| `trusted-header` \| `jwt`. Unknown → `none`. |
| `PADDOCK_AUTH_USER_HEADER` | `X-Forwarded-User` | no | *(trusted-header)* Header carrying the username. |
| `PADDOCK_AUTH_EMAIL_HEADER` | — | no | *(trusted-header)* Header carrying the email. |
| `PADDOCK_AUTH_GROUPS_HEADER` | — | no | Header carrying group membership (comma/space-split in trusted-header mode). |
| `PADDOCK_AUTH_JWT_HEADER` | `Authorization` | no | *(jwt)* Header carrying the token. `Authorization` strips a leading `Bearer `. |
| `PADDOCK_AUTH_JWKS_URL` | — | **jwt** | *(jwt)* IdP JWKS endpoint used to verify the signature. **Required when `PADDOCK_AUTH_MODE=jwt`** — startup fails without it. |
| `PADDOCK_AUTH_JWT_ISSUER` | — | no | *(jwt)* Expected `iss` claim (validated when set). |
| `PADDOCK_AUTH_JWT_AUDIENCE` | — | no | *(jwt)* Expected `aud` claim (validated when set). |
| `PADDOCK_AUTH_USERNAME_CLAIM` | *(auto)* | no | *(jwt)* Claim to read the username from. Default tries `preferred_username` → `email` → `sub`. |
| `PADDOCK_AUTH_GROUPS_CLAIM` | `groups` | no | *(jwt)* Claim to read groups from. |

## Management API (`/mcp`, external callers)

The Management API lets a caller **outside** this instance — a laptop Claude Code
session, or a peer Paddock — drive the same operations Claude reaches through
its in-process `paddock_manage` tools. It is **file-first** configuration, because
a client list doesn't express well as a scalar — the one exception is
`trustedProxies`, which also reads `PADDOCK_MANAGEMENT_TRUSTED_PROXIES` (a flat
list, and the thing a container deployment most often needs to set per-environment).

> **Any write scope is effectively remote code execution on this host.**
> `create_chat`, `send_message`, `fork_chat*` and `run_trigger` start real
> turns, and Claude runs with `Bash`. Read-only is the default for a reason;
> grant writes only to a client whose token you treat as a production secret.

Three properties are worth stating plainly:

- **It authenticates itself.** Independent of `PADDOCK_AUTH_MODE` and of any
  reverse proxy — `/mcp` stays credential-gated even at `auth.mode: none`, and
  running Paddock with no proxy at all is fully supported.
- **It fails closed.** With no `clients` (or no `publicUrl`), `/mcp` returns
  **404** — the endpoint does not exist until you deliberately turn it on. A
  missing or bad credential is **401** with a `WWW-Authenticate` challenge, never
  a redirect to a login page.
- **Token material is referenced, never inlined.** This file is git-tracked, so an
  inline `token:` is a hard error. Point at an environment variable instead.

```yaml
managementApi:
  # Identifies THIS instance. A token minted as `pdk_<instanceId>_<secret>` is
  # refused unless this matches, so copying a credential to another Paddock
  # doesn't make it work there.
  instanceId: my-paddock
  # The canonical public origin clients reach this instance at. Required once
  # `clients` is set: RFC 9728 requires the discovery document's `resource` to
  # byte-match the URL the client used, and that can't be derived from the
  # (attacker-controlled) Host header. Must be https unless it's loopback.
  publicUrl: https://paddock.example.com
  # Whose `X-Forwarded-Proto` the plaintext guard believes. Name your TLS
  # terminator's address here; see "Trusted proxies" below for the default.
  trustedProxies: [172.18.0.0/16]
  clients:
    my-laptop:
      auth:
        # `env:VAR_NAME` is the only supported form.
        ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP
      # Omit `scope` entirely for the read-only default.
    ci:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_CI
      scope:
        projects: [website]        # `["*"]` for all; omit for all
        allow: [list_*, read_chat, create_chat]
        deny: [archive_chat]       # deny always beats allow
        maxSpawnDepth: 1           # can only narrow the project's own bound
```

| Field | Default | Purpose |
|-------|---------|---------|
| `instanceId` | — | Binds `pdk_<instanceId>_…` tokens to this instance. |
| `publicUrl` | — | **Required with `clients`.** Canonical public origin; https unless loopback. |
| `authorizationServers` | `[]` | OAuth issuer URLs, advertised in the discovery document. Leave empty for token-only. |
| `trustedProxies` | `loopback, linklocal, uniquelocal` | Peers whose `X-Forwarded-Proto` the plaintext guard believes. Overridden by `PADDOCK_MANAGEMENT_TRUSTED_PROXIES`. |
| `clients.<id>.auth.ref` | — | **Required.** `env:VAR_NAME` holding the token. Inline values are rejected. |
| `clients.<id>.scope.projects` | `["*"]` | Project slugs this client may reach. |
| `clients.<id>.scope.allow` | `["list_*", "read_chat"]` | Operations it may invoke. Supports a trailing `*`. |
| `clients.<id>.scope.deny` | `[]` | Operations explicitly refused; beats `allow`. |
| `clients.<id>.scope.denyProjects` | `[]` | Projects explicitly refused; beats `projects`. |
| `clients.<id>.scope.maxSpawnDepth` | *(project default)* | Narrows the spawn bound for turns this client starts. |

Operation names match the tool names: `list_projects`, `list_chats`, `read_chat`,
`create_chat`, `fork_chat`, `fork_chat_batch`, `send_message`, `archive_chat`,
`unarchive_chat`, `list_triggers`, `set_trigger`, `remove_trigger`, `run_trigger`.

**Generating a token.** Any high-entropy string of 24+ characters works, but
prefer the bound form so it is useless at another instance and greppable by
secret scanners:

```sh
printf 'pdk_%s_%s' "$(hostname -s)" "$(openssl rand -hex 24)"
```

**Connecting a client.** The endpoint speaks streamable-HTTP MCP at `POST /mcp`:

```sh
claude mcp add --transport http --scope user paddock \
  https://paddock.example.com/mcp --header "Authorization: Bearer pdk_..."
```

Three things that will otherwise cost you an afternoon:

- An entry with a `url` but no `type` is treated as a **stdio** server and fails.
  The CLI sets `"type": "http"` for you; hand-written JSON must include it.
- Use `--scope user` (or `local`). A `--scope project` server needs interactive
  approval before it will connect.
- A configured `Authorization` header and OAuth are **mutually exclusive**: if the
  header is rejected, the client reports a failed connection rather than falling
  back to OAuth.

**Discovery.** Paddock publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` (the path-inserted form, which is what
clients actually request) — but **only when `authorizationServers` is set**. The
MCP spec requires that field, so a token-only deployment publishes no document
rather than an invalid one; clients using a static bearer token never fetch it.

**Behind a proxy.** Any edge gate must **exempt `/mcp`**: a Basic Auth sidecar
collides with the client's own `Authorization: Bearer`, and an SSO proxy answers
with an HTML login redirect that breaks MCP discovery. Ship a Paddock that
authenticates `/mcp` *before* applying the exemption — the fail-closed 404 is the
backstop if the ordering slips. Paddock also refuses plaintext requests from
non-loopback clients, so terminate TLS and forward `X-Forwarded-Proto`.

**Trusted proxies.** `/mcp` carries a bearer token, so it refuses plaintext from
anything but a loopback client. `X-Forwarded-Proto: https` lifts that refusal —
but only from a peer in `trustedProxies`, because the header is set by whoever is
talking to us and a client cannot vouch for its own transport (#474). The peer is
the socket address, so it can't be forged; entries are IPs, CIDRs, the presets
`loopback` / `linklocal` / `uniquelocal`, or the words `none` (believe nobody)
and `all` (believe everybody — the old behaviour, warned about at boot).

| Value | Meaning |
|-------|---------|
| *(unset)* | `loopback, linklocal, uniquelocal` — every private peer is treated as a possible proxy. Keeps sidecar deployments working, but does not distinguish your proxy from any other host on the same private network. |
| `172.18.0.0/16` (or your proxy's IP) | **Recommended.** Only that peer's forwarded scheme is believed — the guard becomes a control rather than a footgun-preventer. |
| `none` | No forwarded scheme is ever believed. Reach `/mcp` over real TLS or over loopback. |
| `all` | Any peer may switch the guard off. Only for a network you fully control. |

Two consequences worth knowing:

- A **public** peer's `X-Forwarded-Proto` is never believed by default. That is the
  case the default posture actually fixes.
- The Docker bridge gateway (`172.17.0.1`) is **not** loopback-equivalent: a remote
  client reaching a `0.0.0.0`-published port is SNAT'd to that same address, so it
  proves nothing about where the traffic came from. To smoke-test a containerised
  instance, go in through the container's own loopback instead of asserting a
  scheme from outside:

  ```sh
  docker compose exec paddock curl -sS -X POST http://127.0.0.1:4000/mcp \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  ```

This setting governs the `/mcp` transport guard only. `PADDOCK_AUTH_MODE=trusted-header`
trusts its identity header from any peer by design — that mode assumes the proxy is
the *sole* ingress (see [AUTH.md](../AUTH.md)), which is a network posture, not a
header check.

## Branding (per-instance)

Defaults preserve today's look; set these to tell several instances apart.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_BRAND_NAME` | `Paddock` | no | Wordmark + browser tab title. |
| `PADDOCK_BRAND_LOGO` | `🐎` | no | An emoji/glyph, or a URL/path to an image (rendered as `<img>`). |
| `PADDOCK_BRAND_ACCENT` | `#c2603c` | no | Accent color (hex) for primary buttons + the logo chip. |

## Voice dictation (Whisper)

Off unless configured; then a mic button appears in the composer. Mirrors
HushPod's whisper config so both can share a backend. See [DEV.md](../DEV.md#voice-dictation).

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_WHISPER_MODE` | `off` (or `remote` if an endpoint is set) | no | `off` \| `remote` \| `local`. Unknown → `off`. |
| `PADDOCK_WHISPER_ENDPOINT` | — | *(remote)* | OpenAI-compatible base URL, e.g. `http://whisper.local:8385/v1` (`/audio/transcriptions` is appended). Its presence flips the default mode to `remote`. |
| `PADDOCK_WHISPER_API_KEY` | — | no | *(remote)* Optional bearer token for the endpoint. |
| `PADDOCK_WHISPER_MODEL` | `base` | no | Whisper model (`tiny`/`base`/`small`/…; `.en` variants for English-only). |
| `PADDOCK_WHISPER_LANGUAGE` | — | no | Optional spoken-language hint (e.g. `en`); unset ⇒ auto-detect. |
| `PADDOCK_WHISPER_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | no | Max accepted dictation upload size. |

## Agents

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_DRIVE_MODE` | `session` | no | Box-wide default for how turns are driven. `session` (the default, #316) runs the persistent `openChatSession` path, enabling cross-turn autonomy (`ScheduleWakeup` / `/loop`) and SDK streaming; set `batch` for the legacy one-shot `trigger()` path. A per-project `driveMode` overrides this at dispatch. Unknown → default. |
| `PADDOCK_MODELS` | *(all)* | no | Comma-separated allow-list of which built-in catalog models the picker offers (e.g. `claude-opus-5,claude-sonnet-5`). Unset ⇒ every catalog model is offered. Unknown ids are dropped; if nothing valid remains the full catalog is offered (never zero). The catalog stays the source of each model's label/context-limit/pricing — this only narrows what's offered. Also settable as a YAML `models:` array, and a per-project `models` override may further subset it. |
| `PADDOCK_NATIVE_PROMPT` | `true` | no | Agents use the native Claude Code system prompt + `CLAUDE.md` hierarchy. Set `0`/`false`/`no` for the terse Paddock "replace" prompt (e.g. an instance with no `CLAUDE.md`). |
| `PADDOCK_SELF_MCP` | `false` | no | Give Claude the read-only self-management MCP (`mcp__paddock_manage__*`: enumerate projects/chats, read another chat's transcript). |
| `PADDOCK_SELF_MCP_WRITE` | `false` | no | Additionally give Claude the self-management **write** tools (`create_chat`, `fork_chat`, `send_message`, `fork_chat_batch`). Only honored when `PADDOCK_SELF_MCP` is also on (write implies read). |
| `PADDOCK_SELF_MCP_PROJECTS` | `false` | no | Additionally give Claude the self-management **project** tool (`create_project`) — provisioning a whole new project, cloning a repo when repo-backed. Gated separately from the other write tools because it creates instance-level state and clones a caller-supplied git URL. Only honored when `PADDOCK_SELF_MCP` and `PADDOCK_SELF_MCP_WRITE` are also on. |
| `PADDOCK_BROWSER_MCP` | *(off)* | no | When `=1`, inject a headless-Chromium Playwright MCP into the agent (browse/screenshot). |

## Git / GitHub

> **Preview servers (`pm`).** Running long-lived dev/preview servers is a
> capability of the **devbox image** (which ships the `pm` PM2 wrapper), advertised
> to Claude by an instance-wide `CLAUDE.md` on the mounted data volume — not a
> Paddock config flag. There is no `PADDOCK_DEV_SERVERS_*` variable.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_GIT_AUTHOR_NAME` | `Paddock` | no | Author name for commits the server makes on the backing store. |
| `PADDOCK_GIT_AUTHOR_EMAIL` | `paddock@localhost` | no | Author email for those commits. |
| `PADDOCK_GITHUB_CLIENT_ID` | — | *(for GitHub auth)* | GitHub OAuth **client id** enabling the device-flow connect. Without it the GitHub-auth feature reports "not configured"; invoking a flow throws. |

## Sweep (advanced)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_SWEEP_MIN_INTERVAL_MS` | `300000` (5 min) | no | Minimum interval between post-turn per-project sweeps. Must parse to a finite number ≥ 0, else ignored (falls back to the 5-min default). |

## Non-`PADDOCK_` runtime variables

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | conditional | Claude **Max plan** auth. Read from the server's environment and passed through to the `claude` process the runtime spawns; never written to config. Provide this **or** `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY` | — | conditional | Claude **API-key** auth (API pricing). Alternative to `CLAUDE_CODE_OAUTH_TOKEN`. |
| `LOG_LEVEL` | `info` | no | Fastify/pino log level (`fatal`…`trace`). |

> Which auth you use is **independent of the runtime** — either credential works
> on both the SDK runtime (chats) and the CLI runtime (the sweeper, triggers,
> `driveMode: batch`). Credentials are consumed by the runtime, not read directly
> by Paddock server code — but the server process must have one in its environment
> for turns to run.

## Web build / dev-proxy variables

Read by the Vite build/dev server (`packages/web`), not the backend:

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_DEV_PORT` | `5173` | no | Vite dev-server port (hot-reload mode). |
| `PADDOCK_PROXY_TARGET` | `http://localhost:4000` | no | Backend origin the Vite dev server proxies `/api` + `/ws` to (WS target derived by swapping `http`→`ws`). |
| `VITE_API_BASE` | *(same-origin)* | no | Build-time: point the SPA at a non-default API origin. |
| `VITE_WS_BASE` | *(same-origin)* | no | Build-time: point the SPA at a non-default WebSocket origin. |
