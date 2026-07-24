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
  `PADDOCK_KEEPER_NATIVE_PROMPT`, which is on by default and only `0` / `false` /
  `no` turns it off.
- **Unknown enum values fall back to the default** rather than failing startup
  (e.g. an unrecognised `PADDOCK_AUTH_MODE` becomes `none`).
- **Paths** are resolved to absolute and canonicalised (symlinks resolved) so
  Claude Code session discovery can find transcripts.

---

## Core / paths

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_DATA_DIR` | `./data` | no | Data root. **All paths below default to subdirectories of this** — set it and everything cascades. Holds projects, scratch, generated herdctl config, and state. |
| `PADDOCK_PROJECTS_DIR` | `<data>/projects` | no | Root that contains per-project directories (each is a keeper's working dir). |
| `PADDOCK_SCRATCH_DIR` | `<data>/scratch` | no | Working directory for one-off / scratch chats. |
| `PADDOCK_STATE_DIR` | `<data>/.herdctl` | no | herdctl state directory. |
| `PADDOCK_HERDCTL_CONFIG` | `<data>/herdctl.yaml` | no | Path to the generated `herdctl.yaml` the FleetManager loads (Paddock owns/regenerates it). |
| `PADDOCK_WEB_DIST` | `packages/web/dist` | no | Built SPA served in production (resolved relative to the server module). |
| `PORT` | `4000` | no | HTTP/WS listen port. |
| `HOST` | `0.0.0.0` | no | Bind host. |
| `CLAUDE_HOME` | `~/.claude` | no | Claude home used for session/transcript discovery. |

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
| `PADDOCK_WHISPER_ENDPOINT` | — | *(remote)* | OpenAI-compatible base URL, e.g. `http://192.168.1.200:8385/v1` (`/audio/transcriptions` is appended). Its presence flips the default mode to `remote`. |
| `PADDOCK_WHISPER_API_KEY` | — | no | *(remote)* Optional bearer token for the endpoint. |
| `PADDOCK_WHISPER_MODEL` | `base` | no | Whisper model (`tiny`/`base`/`small`/…; `.en` variants for English-only). |
| `PADDOCK_WHISPER_LANGUAGE` | — | no | Optional spoken-language hint (e.g. `en`); unset ⇒ auto-detect. |
| `PADDOCK_WHISPER_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | no | Max accepted dictation upload size. |

## Keeper / agents

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_KEEPER_DRIVE_MODE` | `session` | no | Box-wide default for how keeper turns are driven. `session` (the built-in default since v0.36) enables cross-turn autonomy (`ScheduleWakeup` / `/loop`) and token-by-token streaming; `batch` is one-shot per turn. A per-project `driveMode` overrides this at dispatch. Unknown → default. |
| `PADDOCK_KEEPER_NATIVE_PROMPT` | `true` | no | Keeper **and** scratch agents use the native Claude Code system prompt + `CLAUDE.md` hierarchy. Set `0`/`false`/`no` for the terse Paddock "replace" prompt (e.g. an instance with no `CLAUDE.md`). |
| `PADDOCK_SELF_MCP` | `false` | no | Give keepers the read-only self-management MCP (`mcp__paddock_manage__*`: enumerate projects/chats, read another chat's transcript). Never injected on scratch turns. |
| `PADDOCK_SELF_MCP_WRITE` | `false` | no | Additionally give keepers the self-management **write** tools (`create_chat`, `fork_chat`, `send_message`, `fork_chat_batch`). Only honored when `PADDOCK_SELF_MCP` is also on (write implies read). |
| `PADDOCK_HOOKS_MCP` | `false` | no | Instance default for the hook/trigger-management tools (`list_triggers` / `set_trigger` / `remove_trigger`) — a keeper declaring and editing its own [event hooks](/concepts/hooks/) and schedules. Off by default; a per-project `hooksMcpEnabled` in `project.yaml` overrides it. Only honored when the self-management **write** MCP is also on; when off the tools are **absent** (not present-but-refusing). Accepts `1`/`true`/`yes`. |
| `PADDOCK_BROWSER_MCP` | *(off)* | no | When `=1`, inject a headless-Chromium Playwright MCP into keepers (browse/screenshot). |

## Keeper-chat recovery

Unstick a keeper that hangs when a background task is killed at the turn boundary.
See [Keeper-chat recovery](/configuration/keeper-recovery) for the full story; each
knob has a per-project `recovery` override in `project.yaml`.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_RECOVERY_SURFACE` | `true` (ON) | no | **Layer 2.** Surface a killed/stopped background-task notification as a "keeper is idle" affordance with a one-click **Continue** button. Accepts `1`/`true`/`yes`. |
| `PADDOCK_RECOVERY_AUTODRIVE` | `false` (OFF) | no | **Layer 3.** Automatically re-drive a hung keeper — Paddock detects the killed task and injects the nudge on its own (debounce + retry-cap guarded). Off by default (it acts unattended and costs a turn). |
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
(which ships the `pm` PM2 wrapper), advertised to keepers by an instance-wide
`CLAUDE.md` on the mounted data volume — not a Paddock config flag. There is no
`PADDOCK_DEV_SERVERS_*` variable.
:::

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_GIT_AUTHOR_NAME` | `Paddock` | no | Author name for commits the server makes on the backing store. |
| `PADDOCK_GIT_AUTHOR_EMAIL` | `paddock@localhost` | no | Author email for those commits. |
| `PADDOCK_GITHUB_CLIENT_ID` | — | *(for GitHub auth)* | GitHub OAuth **client id** enabling the device-flow connect. Without it the GitHub-auth feature reports "not configured"; invoking a flow throws. |

## Sweep / spike (advanced)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_SWEEP_MIN_INTERVAL_MS` | `300000` (5 min) | no | Minimum interval between post-turn per-project sweeps. Must parse to a finite number ≥ 0, else ignored (falls back to the 5-min default). |
| `PADDOCK_SPIKE_TRIGGER` | *(off)* | no | Dev harness only (`spike.ts`): when `=1`, fire a real keeper trigger instead of a dry run. Not used by the running server. |

## Non-`PADDOCK_` runtime variables

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | conditional | Claude **Max** auth for the CLI runtime (the default). Read from the server's environment and passed through to the spawned `claude` CLI; never written to config. Provide this **or** `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY` | — | conditional | Claude auth for the **SDK** runtime (API pricing). Alternative to `CLAUDE_CODE_OAUTH_TOKEN`. |
| `LOG_LEVEL` | `info` | no | Fastify/pino log level (`fatal`…`trace`). |

> Claude credentials are consumed by the runtime (the `claude` CLI subprocess or
> the SDK), not read directly by Paddock server code — but the server process must
> have one in its environment for keeper turns to run.

## Web build / dev-proxy variables

Read by the Vite build/dev server (`packages/web`), not the backend:

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PADDOCK_DEV_PORT` | `5173` | no | Vite dev-server port (hot-reload mode). |
| `PADDOCK_PROXY_TARGET` | `http://localhost:4000` | no | Backend origin the Vite dev server proxies `/api` + `/ws` to (WS target derived by swapping `http`→`ws`). |
| `VITE_API_BASE` | *(same-origin)* | no | Build-time: point the SPA at a non-default API origin. |
| `VITE_WS_BASE` | *(same-origin)* | no | Build-time: point the SPA at a non-default WebSocket origin. |
