---
title: "Environment variables"
description: "Every PADDOCK_* environment variable, with its default and purpose."
---

Paddock is configured from the environment: every setting is read once at startup
(`packages/server/src/config.ts`), normalised, and frozen. This page is the
canonical list of every variable the server reads, its default (taken from the
code, not guessed), and what it does.

:::tip[Prefer a file?]
You can also keep an instance's settings in a single YAML file instead of a long
list of `PADDOCK_*` variables — environment variables still override it. Nearly
every setting below has a matching key (the runtime credentials and Vite
web-build variables are the exceptions); see
**[Config file (YAML)](/configuration/config-file/)**.
:::

For a runnable starting point, copy [`.env.example`](../.env.example) to `.env`
and adjust. Authentication is summarised below but documented in full in
[AUTH.md](/configuration/authentication).

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
| `PADDOCK_DATA_DIR` | `./data` | no | Data root. **All paths below default to subdirectories of this** — set it and everything cascades. Holds projects, generated herdctl config, and state. |
| `PADDOCK_CONFIG` | `<data>/paddock.config.yaml` | no | Path to the optional YAML instance-config file — the base layer *beneath* every variable on this page. Resolved against the bootstrap data dir when unset; a missing file **there** is fine (env-only deployments are unaffected), but an explicitly-set path that doesn't exist is a **startup error**, so a typo can't silently boot an instance with none of your settings. See [Config file (YAML)](/configuration/config-file/). |
| `PADDOCK_PROJECTS_DIR` | `<data>/projects` | no | Root that contains per-project directories (each is an agent's working dir). |
| `PADDOCK_STATE_DIR` | `<data>/.herdctl` | no | herdctl state directory. |
| `PADDOCK_HERDCTL_CONFIG` | `<data>/herdctl.yaml` | no | Path to the generated `herdctl.yaml` the FleetManager loads (Paddock owns/regenerates it). |
| `PADDOCK_WEB_DIST` | `packages/web/dist` | no | Built SPA served in production (resolved relative to the server module). |
| `PORT` | `4000` | no | HTTP/WS listen port. |
| `HOST` | `127.0.0.1` | no | Bind host. **Safe by default:** defaults to loopback, so a fresh run is network-closed. `PADDOCK_HOST` is an alias. Set to `0.0.0.0` (all interfaces) only behind auth or a proxy — see the guard below. |
| `PADDOCK_DANGEROUSLY_ALLOW_OPEN` | `false` | no | Escape hatch for the open-server guard: allow a non-loopback bind **with no authentication** (`PADDOCK_AUTH_MODE=none`). Accepts `1`/`true`/`yes`. Without it, that combination **refuses to start**; with it, the server boots but logs a loud one-line warning. Leave unset unless you truly intend an unauthenticated server on a routable interface. |
| `CLAUDE_HOME` | `<dataDir>/claude-home` | no | The Claude home Paddock runs its agents against — the directory whose `projects/<encoded-cwd>/` folders hold Claude Code's session transcripts, and the value handed to Claude Code as `CLAUDE_CONFIG_DIR`. **Paddock owns this directory** (#620): the data dir is a single relocatable root, and the user's `~/.claude` is a read-only source Paddock imports out of but never writes to. Precedence: `CLAUDE_HOME`, then `CLAUDE_CONFIG_DIR`, then a `claudeHome:` config-file key, then the default. `CLAUDE_CONFIG_DIR` is honoured because herdctl deliberately refuses to clobber an operator-set value (herdctl#423) — if Paddock disagreed with it, the SDK would write transcripts to one tree while herdctl read from another. Resolved **once** at startup into `PaddockConfig.claudeHome` (`resolveClaudeHome()` in `config.ts`) and threaded to *both* consumers: Paddock's transcript relocation and import detection (`ensureProjectChats` in `transcripts.ts`, `AdoptableIndex` in `adoptable.ts`), **and** the engine, as `FleetManagerOptions.claudeHomePath` (`herdctl.ts`). It is deliberately one value: were Paddock to honour this variable while the engine fell back to `$HOME/.claude`, chats would **list from one directory and open empty from another** (#588). Set it to `$HOME/.claude` to restore the pre-#620 layout exactly. |
| `CLAUDE_CONFIG_DIR` | *(unset)* | no | Claude Code's own home variable. When set, Paddock adopts it as its Claude home rather than picking a different one (see above). Note that Claude Code scopes its credential store to whether this is set at all, so a keychain login made against the default home is not visible under a relocated one — Paddock warns at boot when it can find no credential source. |


> **Safe-by-default binding.** Paddock runs code and spends Claude tokens, so it
> refuses to expose itself carelessly. The bind host defaults to `127.0.0.1`
> (loopback only), and binding a **non-loopback** host (e.g. `0.0.0.0`) while
> authentication is `none` **fails closed at startup** — mirroring the
> jwt-without-JWKS check. The container images still bind `0.0.0.0` by design, but
> they are **not** exempt from that check — a container run needs an auth mode or
> `PADDOCK_DANGEROUSLY_ALLOW_OPEN=1`, or it won't start at all.
>
> The default changed in **v0.44**, which is breaking if you relied on the old
> `0.0.0.0`. See **[Binding & network exposure](/configuration/binding-and-exposure/)**
> for what counts as loopback, the exact guard conditions, the container story,
> and how to fix an upgraded instance you can no longer reach.

> **`PADDOCK_CONFIG__*` is not implemented.** There is no generic
> `PADDOCK_CONFIG__foo__bar` → nested-herdctl-key override mechanism in this tree.
> (The similarly-named `window.__PADDOCK_CONFIG__` is a browser global the server
> injects into `index.html` to carry branding to the SPA — not an env var.)

## Authentication

Provider-agnostic; the default (`none`) is fully open. See **[AUTH.md](/configuration/authentication)**
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

## Management API tokens (`PADDOCK_MCP_TOKEN_*`)

The external [Management API](/reference/mcp/) at `/mcp` has **no `PADDOCK_*`
variables of its own** — the whole `managementApi` block is
[config-file-only](/configuration/config-file/#managementapi--the-file-first-block).
The environment's job is to hold the **client tokens**, which the file only ever
*references*:

```yaml
managementApi:
  clients:
    my-laptop:
      auth:
        ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP
```

```bash
PADDOCK_MCP_TOKEN_MY_LAPTOP=pdk_my-paddock_1a2b3c…
```

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_MCP_TOKEN_<CLIENT>` | — | *(per configured client)* | The bearer token for one `managementApi.clients` entry. The **name is a convention, not a built-in** — the variable read is whatever the client's `auth.ref` names, and Paddock's own error messages suggest this shape, uppercasing the client id and replacing every non-alphanumeric character with an underscore. Minimum 24 characters; prefer `pdk_<instanceId>_<secret>` so the token is bound to one instance. Unset, blank, or too short ⇒ that client is **dropped** with a warning. |

`env:VAR_NAME` is the only supported form of `auth.ref`, and an inline `token:`
or `secret:` in the YAML is a hard config error — the config file is git-tracked.
Deliver these like any other runtime credential: from a secrets manager or a
secrets file, not a committed `.env`.

## OpenAPI / Swagger reference

Opt-in, and off on a plain instance: mounting it publishes a map of the whole HTTP
surface, so it's a deliberate choice. When enabled the instance serves a branded
Swagger UI whose security schemes reflect *its own* auth mode. See
**[OpenAPI & Swagger](/configuration/openapi/)** for the whole surface, and
[`/api/`](/api/) for the always-available published reference for the latest release.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_OPENAPI_ENABLED` | `false` (OFF) | no | Mount the Swagger UI + the raw spec. Accepts `1`/`true`/`yes`/`on` — note this one also takes `on`, which the other boolean knobs don't. When off, none of the routes exist. |
| `PADDOCK_OPENAPI_PATH` | `/open-api` | no | Route prefix the UI mounts under. Normalised to a leading slash with no trailing slash, so `open-api/` and `/open-api` are the same thing. The raw spec follows it: `<path>/json` plus a `<path>.json` alias. |

## Branding (per-instance)

Defaults preserve today's look; set these to tell several instances apart.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_BRAND_NAME` | `Paddock` | no | Wordmark + browser tab title. |
| `PADDOCK_BRAND_LOGO` | `🐎` | no | An emoji/glyph, or a URL/path to an image (rendered as `<img>`). |
| `PADDOCK_BRAND_ACCENT` | `#c2603c` | no | Accent color (hex) for primary buttons + the logo chip. |

## Voice dictation (Whisper)

Off unless configured; then a mic button appears in the composer. Mirrors
HushPod's whisper config so both can share a backend. See [DEV.md](https://github.com/edspencer/paddock/blob/main/DEV.md#voice-dictation).

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
| `PADDOCK_DRIVE_MODE` | `session` | no | Box-wide default for how turns are driven. `session` (the built-in default since v0.36) enables cross-turn autonomy (`ScheduleWakeup` / `/loop`) and token-by-token streaming; `batch` is one-shot per turn. A per-project `driveMode` overrides this at dispatch. Unknown → default. |
| `PADDOCK_MODELS` | *(every catalog model)* | no | Comma-separated allow-list of built-in catalog model **ids** (e.g. `claude-opus-5,claude-sonnet-5`) the model picker and the per-project default may offer. Unset ⇒ every catalog model is offered. Unknown, blank and duplicate ids are dropped silently, and if nothing valid survives the full catalog is offered again — **an instance never ends up offering zero models.** A per-project list can narrow this further, never widen it. See [Model allow-lists](/configuration/models/). |
| `PADDOCK_NATIVE_PROMPT` | `true` | no | Agents use the native Claude Code system prompt + `CLAUDE.md` hierarchy. Set `0`/`false`/`no` for the terse Paddock "replace" prompt (e.g. an instance with no `CLAUDE.md`). |
| `PADDOCK_SELF_MCP` | `false` | no | Give Claude the read-only self-management MCP (`mcp__paddock_manage__*`: enumerate projects/chats, read another chat's transcript). |
| `PADDOCK_SELF_MCP_WRITE` | `false` | no | Additionally give Claude the self-management **write** tools (`create_chat`, `fork_chat`, `send_message`, `fork_chat_batch`). Only honored when `PADDOCK_SELF_MCP` is also on (write implies read). |
| `PADDOCK_SELF_MCP_PROJECTS` | `false` | no | Additionally give Claude the self-management **project** tool (`create_project`) — provisioning a whole new project, cloning a repo when repo-backed. Gated separately from the other write tools because it creates instance-level state and clones a caller-supplied git URL. Only honored when `PADDOCK_SELF_MCP` and `PADDOCK_SELF_MCP_WRITE` are also on. |
| `PADDOCK_MAX_SPAWN_DEPTH` | `1` | no | How deep a spawn tree may grow before spawned children stop receiving the self-management MCP: a spawned turn at depth `d` gets it (including the write tools, so a child can `send_message` back to its parent) only while `d ≤` this value. `0` means no spawned child ever gets it. A per-project `maxSpawnDepth` overrides this at dispatch; an out-of-range value falls back to the default rather than failing startup. Only meaningful when the **write** self-MCP is on — spawning needs those tools. |
| `PADDOCK_SCHEDULE_MUTATION` | `false` | no | Allow schedules to be created / edited / deleted **programmatically** at runtime (the Schedules REST routes and the trigger MCP tools). Off by default, so a plain instance's schedules can only change by editing `project.yaml`. Schedules declared statically in `project.yaml` are armed either way. Accepts `1`/`true`/`yes`. See [Scheduling & the schedule gates](/configuration/schedules/). |
| `PADDOCK_HOOKS_MCP` | `false` | no | Instance default for the hook/trigger-management tools (`list_triggers` / `set_trigger` / `remove_trigger`) — Claude declaring and editing its own [event hooks](/concepts/hooks/) and schedules. Off by default; a per-project `hooksMcpEnabled` in `project.yaml` overrides it. Only honored when the self-management **write** MCP is also on; when off the tools are **absent** (not present-but-refusing). Accepts `1`/`true`/`yes`. |
| `PADDOCK_ENVIRONMENT_PROMPT` | *(Paddock's built-in text)* | no | Text **appended** to every keeper turn's system prompt, telling the agent it renders into a browser as GitHub-Flavored Markdown rather than into a terminal. Any value replaces the built-in text entirely. See below, and [the environment prompt](/configuration/instance-settings/#the-environment-prompt). |
| `PADDOCK_BROWSER_MCP` | *(off)* | no | When `=1`, inject a headless-Chromium Playwright MCP into the agent (browse/screenshot). |

### The environment prompt is the one place blank is *not* unset

`PADDOCK_ENVIRONMENT_PROMPT` breaks the "blank is unset" rule at the top of this page,
on purpose: an empty value is how you **opt out**, so there has to be a difference
between "unset" and "set to nothing".

```bash
# unset            → Paddock's built-in two-rule prompt is appended
PADDOCK_ENVIRONMENT_PROMPT="Link every Jira key as a URL."   # → that, instead
PADDOCK_ENVIRONMENT_PROMPT=""                                # → nothing appended
```

Because it is *defined-ness* rather than emptiness that decides, an exported-but-empty
`PADDOCK_ENVIRONMENT_PROMPT` still shadows the config file — and the Settings screen
correctly renders the field read-only in that case. `PADDOCK_BROWSER_MCP` behaves the
same way, for the same reason.

The value is used verbatim: no trimming, no escaping. Leading indentation and trailing
newlines survive.

:::caution[Drive mode `batch` keeps the native prompt instead]
On `driveMode: batch`, turns go through herdctl's CLI runtime, which has no
`--append-system-prompt` — it folds an append into `--system-prompt`, and that
**replaces** Claude Code's preset when there is nothing to append onto. So a batch
instance with `PADDOCK_NATIVE_PROMPT=true` (the default) gets **no** environment prompt,
rather than getting it at the cost of the entire coding preset. Turn the native prompt
off and the two are concatenated as expected. The default drive mode, `session`, is
unaffected — the SDK runtime appends properly.
:::

## Chat recovery

Unstick a chat that hangs when a background task is killed at the turn boundary.
See [Chat recovery](/configuration/chat-recovery) for the full story; each knob has
a per-project `recovery` override in `project.yaml`.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_RECOVERY_SURFACE` | `true` (ON) | no | **Layer 2.** Surface a killed/stopped background-task notification as a "Claude is idle" affordance with a one-click **Continue** button. Accepts `1`/`true`/`yes`. |
| `PADDOCK_RECOVERY_AUTODRIVE` | `false` (OFF) | no | **Layer 3.** Automatically re-drive a hung chat — Paddock detects the killed task and injects the nudge on its own (debounce + retry-cap guarded). Off by default (it acts unattended and costs a turn). |
| `PADDOCK_RECOVERY_DEBOUNCE_MS` | `5000` | no | Layer 3: quiet window (ms) after a killed task before auto re-drive fires. Non-negative integer, else the default. |
| `PADDOCK_RECOVERY_MAX_RETRIES` | `1` | no | Layer 3: per-session cap on auto re-drives (no poke-loops). Non-negative integer, else the default. |
| `PADDOCK_RECOVERY_LIMBO_MS` | `0` (off) | no | Layer 2 backstop: surface a kept-alive session as stuck after this many ms of silence following a killed task. `0` disables it. *(Backstop timer ships in a follow-up — config only for now.)* |

## Attachments (inbound uploads)

Gate the composer's file/image upload (v0.38). All four knobs also take a
per-project `attachments` override in `project.yaml` (each field inherits the
instance default when unset), resolved at request time. See
[Sending files & images](/using/sending-files-and-images/) for the feature.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_ATTACHMENTS_ENABLED` | `true` (ON) | no | Master switch for inbound composer uploads. When off, the upload endpoint `403`s and the composer hides its picker / drop / paste affordances. Accepts `1`/`true`/`yes`. |
| `PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB` | `25` | no | Per-file size cap in MB (1 MB = 1024×1024 bytes). A larger file is rejected before it's written. Must be a positive integer, else the default. |
| `PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE` | `10` | no | How many files a single message may carry. Enforced client-side (tray cap) **and** server-side (per upload request + at send). Positive integer, else the default. |
| `PADDOCK_ATTACHMENTS_ALLOWED_TYPES` | `*` (allow all) | no | Comma-separated allow-list of MIME patterns (`image/*`, `application/pdf`) and/or extensions (`.csv`, `.pdf`). A file passes if its MIME matches any pattern **or** its extension matches any extension entry; the sentinel `*` allows everything. A hygiene/UX guardrail, **not** a security boundary (client-provided types, no magic-byte sniffing). |

## Git / GitHub

:::note[Preview servers (`pm`)]
Running long-lived dev/preview servers is a capability of the **devbox image**
(which ships the `pm` PM2 wrapper), advertised to Claude by an instance-wide
`CLAUDE.md` on the mounted data volume — not a Paddock config flag. There is no
`PADDOCK_DEV_SERVERS_*` variable.
:::

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_GIT_AUTHOR_NAME` | `Paddock` | no | Author name for commits the server makes on the backing store. |
| `PADDOCK_GIT_AUTHOR_EMAIL` | `paddock@localhost` | no | Author email for those commits. |
| `PADDOCK_GITHUB_CLIENT_ID` | — | *(for GitHub auth)* | GitHub OAuth **client id** enabling the device-flow connect. Without it the GitHub-auth feature reports "not configured"; invoking a flow throws. |

## Curation (sweeper token budgets)

Per-file token budgets the post-turn [sweeper](/concepts/sweeper/) keeps its three
curated files under. These bound the context **every** chat in a project pays for:
`CHANGELOG.md` and `OVERVIEW.md` are injected into the project-context preload, and
`CLAUDE.md` auto-loads on every turn. The sweeper is told each budget so it prunes and
de-duplicates to fit, and the server enforces it as a backstop. Each one also takes a
per-project `curation` override in `project.yaml`, field by field.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_CURATION_OVERVIEW_MAX_TOKENS` | `2000` | no | Budget for `OVERVIEW.md`, which the sweeper regenerates wholesale each time. |
| `PADDOCK_CURATION_CHANGELOG_MAX_TOKENS` | `8000` | no | Budget for `CHANGELOG.md`. The biggest lever — it's the largest of the three and it rides in the preload. |
| `PADDOCK_CURATION_CLAUDEMD_MAX_TOKENS` | `6000` | no | Budget for the curated-notes section of `CLAUDE.md`. **Mind the name:** the variable says `CLAUDEMD` but the config-file key is `curation.claudeMaxTokens`. |

Each must parse to a **positive** integer; anything else (zero, negative,
non-numeric, blank) falls back to the default rather than failing startup.

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
