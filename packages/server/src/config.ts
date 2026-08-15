/**
 * Paddock server configuration, sourced from an optional YAML instance-config
 * file with environment overrides on top (precedence: file < env), and sane
 * defaults beneath both.
 *
 * Everything is resolved once at startup so the rest of the app can import a
 * frozen object. Paths are normalised to absolute.
 *
 * **Retired settings are IGNORED, never fatal** (#549). Config is pull-based on
 * both layers: env vars are read by name via {@link envOr}, and the YAML file is
 * parsed into a loose record whose keys are only ever read, never enumerated or
 * validated against a schema. So a setting Paddock has since deleted is simply
 * never looked at — boot succeeds and the value has no effect. This is a property
 * of the resolution shape rather than a compatibility shim, so it needs no
 * per-key upkeep as settings come and go. The cost is that a typo'd key is
 * equally silent; that trade is deliberate — an operator should not be hard-failed
 * out of a running instance by a stale line in an old env file. Pinned by
 * `test/unit/config.test.ts`.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  type DriveMode,
  DEFAULT_DRIVE_MODE,
  isKnownDriveMode,
  isKnownModel,
} from "./models.js";
import { SCHEMA_VERSION_KEY, configSchemaRefusal } from "./schema-version.js";
import { isValidMaxSpawnDepth } from "./spawn-capability.js";
import {
  type Posture,
  type ProfileName,
  posture as postureFor,
  resolveProfileName,
} from "./profiles.js";
import { type TranscriptsMode, isKnownTranscriptsMode } from "./transcripts.js";
import { type CredentialsMode, isKnownCredentialsMode } from "./claude-credentials.js";
import { type InstructionsMode, isKnownInstructionsMode } from "./claude-instructions.js";
import { type HooksMode, isKnownHooksMode } from "./claude-settings.js";
import {
  type McpServersMode,
  type McpServerDefs,
  isKnownMcpServersMode,
} from "./claude-mcp.js";
import { resolveDeclaredMcpServers, type McpServersConfigFile } from "./mcp-servers.js";
import { DEFAULT_ENVIRONMENT_PROMPT } from "./environment-prompt.js";
import { type RecoveryConfig, DEFAULT_RECOVERY } from "./recovery-config.js";
import { type CurationConfig, DEFAULT_CURATION } from "./curation-config.js";
import {
  resolveManagementApiConfig,
  type ManagementApiConfig,
  type ManagementApiConfigFile,
} from "./management-config.js";
import {
  type AttachmentsConfig,
  DEFAULT_ATTACHMENTS,
  sanitizeAllowedTypes,
} from "./attachments-config.js";

/**
 * User-authentication strategy.
 *
 * - `none`            — no auth; every request is anonymous (default, fully open).
 * - `trusted-header`  — trust a reverse proxy to have authenticated the user and
 *                       pass identity in headers. Spoofable unless the proxy is
 *                       the only path to paddock (network-level trust).
 * - `jwt`             — verify a signed JWT (issued by the proxy/IdP) against a
 *                       remote JWKS. Self-contained / zero-trust: spoof-proof
 *                       even if a request reaches paddock directly.
 */
export type AuthMode = "none" | "trusted-header" | "jwt";

/**
 * Resolved authentication configuration (provider-agnostic).
 *
 * Driven entirely by `PADDOCK_AUTH_*` env vars so paddock is not coupled to any
 * single proxy/IdP (Authentik, oauth2-proxy, Authelia, Cloudflare Access,
 * Keycloak, …). See AUTH.md for the modes and provider examples.
 */
export interface AuthConfig {
  mode: AuthMode;
  /** trusted-header: header carrying the username (required in that mode). */
  userHeader: string;
  /** trusted-header: optional header carrying the user's email. */
  emailHeader?: string;
  /**
   * trusted-header / jwt: optional header carrying group membership. In
   * trusted-header mode the value is split on comma; in jwt mode this overrides
   * the claim source only when the proxy passes groups as a header (rare).
   */
  groupsHeader?: string;
  /** jwt: header carrying the token. `Authorization` strips a leading `Bearer `. */
  jwtHeader: string;
  /** jwt: JWKS endpoint used to verify the token signature (required in jwt mode). */
  jwksUrl?: string;
  /** jwt: expected `iss` claim (validated when set). */
  jwtIssuer?: string;
  /** jwt: expected `aud` claim (validated when set). */
  jwtAudience?: string;
  /** jwt: claim to read the username from (falls back preferred_username→email→sub). */
  usernameClaim?: string;
  /** jwt: claim to read groups from (default `groups`). */
  groupsClaim: string;
}

/**
 * Per-instance branding (issue #34). Lets several Paddock instances (Projects,
 * Homelab, House, …) be told apart at a glance. All optional; the defaults
 * preserve today's look (🐎 / "Paddock" / terracotta). Injected into index.html
 * at serve time (so there's no title/color flash) and read by the SPA from a
 * `window.__PADDOCK_CONFIG__` global.
 */
export interface BrandConfig {
  /** Wordmark shown top-left and as the browser tab title. */
  name: string;
  /** Logo: an emoji/glyph, OR a URL/absolute path to an image (rendered as <img>). */
  logo: string;
  /** Accent color as a hex string driving the primary buttons + logo chip. */
  accent: string;
}

/**
 * What this instance shares with the host machine's Claude Code (#691).
 *
 * One key per concern, one vocabulary: `own` is paddock's, isolated inside the
 * data dir; `host` is this machine's Claude Code. `own` everywhere is the
 * guarantee an operator should be able to read straight off the config file —
 * **nothing outside the data dir is read or written**.
 *
 * All five levers of #691's sequence now exist. Each is a key here rather than
 * another meaning welded onto the Claude home, which is how the three incidents
 * (#682, #683, #689) that motivated this all happened. What remains of #691 is
 * step 6 — a place for a user to declare their OWN MCP servers, which is a
 * different question from whose existing ones this instance borrows.
 */
export interface ClaudeConfig {
  /**
   * Whose session transcripts this instance uses. `own` (default) keeps them in
   * each project's `.chats/`; `host` shares the user's real
   * `~/.claude/projects/<encoded-cwd>/` folder live, in both directions.
   *
   * Driven by `PADDOCK_CLAUDE_TRANSCRIPTS`, then the `claude.transcripts:` key.
   * See `transcripts.ts` for the mechanism and why it is not a repointed
   * `CLAUDE_CONFIG_DIR`.
   */
  transcripts: TranscriptsMode;
  /**
   * Whose Claude Code login this instance uses. `host` (the default, and the ONE
   * key that does not default to `own`) also reads this machine's own login — the
   * macOS Keychain entry on darwin, the user's `~/.claude/.credentials.json`
   * elsewhere; `own` uses only what is inside paddock's own Claude home.
   *
   * Driven by `PADDOCK_CLAUDE_CREDENTIALS`, then the `claude.credentials:` key.
   * See `claude-credentials.ts` for the mechanism, and for why sharing a login is
   * the safe default when everything else here isolates.
   */
  credentials: CredentialsMode;
  /**
   * Whose user-level instructions this instance loads — the user's `~/.claude`
   * `CLAUDE.md`, `agents/`, `commands/` and `plugins/`. `own` (default) loads
   * none of them; `host` symlinks them in, which is what every version before
   * this one did unconditionally.
   *
   * Driven by `PADDOCK_CLAUDE_INSTRUCTIONS`, then the `claude.instructions:` key.
   * See `claude-instructions.ts` — including the case AGAINST this default,
   * which is real and is kept there rather than deleted.
   */
  instructions: InstructionsMode;
  /**
   * Whether this instance runs the host machine's Claude Code hooks — shell
   * commands `~/.claude/settings.json` binds to tool use and session lifecycle.
   * `own` (default) writes paddock's own `settings.json` carrying every other key
   * of the user's with `hooks` dropped; `host` symlinks theirs in whole.
   *
   * Driven by `PADDOCK_CLAUDE_HOOKS`, then the `claude.hooks:` key. The one lever
   * here that governs code execution rather than data — see `claude-settings.ts`.
   */
  hooks: HooksMode;
  /**
   * Whose MCP servers this instance's keepers get. `own` (default) attaches only
   * the servers paddock itself provides; `host` also attaches the ones declared
   * in the user's `~/.claude.json` — the top-level `mcpServers` plus any scoped
   * to a project's own working directory.
   *
   * Driven by `PADDOCK_CLAUDE_MCP_SERVERS`, then the `claude.mcpServers:` key.
   * The one lever whose source is NOT inside `~/.claude` — see `claude-mcp.ts`
   * for why that made it break silently and separately from the other four.
   */
  mcpServers: McpServersMode;
}

/** OpenAPI / Swagger-UI reference surface config (see PaddockConfig.openapi). */
export interface OpenApiConfig {
  /** Mount the `/open-api` UI + `/open-api.json` spec. Opt-in — defaults false. */
  enabled: boolean;
  /** Route prefix the UI is served under (raw spec at `<path>.json`). */
  path: string;
}

export interface PaddockConfig {
  /**
   * The resolved posture profile (#878) — `paranoid` | `balanced` | `yolo`.
   *
   * Reported for display and provenance only; nothing reads it to make a
   * decision. It has already been expanded into the individual posture fields
   * below by the time this object exists, and any of those the operator set
   * explicitly (file key or env var) has overridden the profile's value — so the
   * profile name tells you where the UNSET levers came from, not what every
   * lever is. See `profiles.ts` for the precedence chain.
   */
  profile: ProfileName;
  /** HTTP/WS port. */
  port: number;
  /** Bind host. Defaults to loopback (`127.0.0.1`) — safe by default (#435). */
  host: string;
  /**
   * Dangerously opt in to an OPEN, unauthenticated server: allow a non-loopback
   * bind while `auth.mode === "none"` (which the bind-safety guard otherwise
   * refuses). Driven by `PADDOCK_DANGEROUSLY_ALLOW_OPEN`; accepts 1/true/yes.
   */
  dangerouslyAllowOpen: boolean;
  /** Absolute (canonical) path to the data root. Holds state files (e.g. sweep). */
  dataDir: string;
  /** Absolute path to the root that contains per-project directories. */
  projectsRoot: string;
  /** Absolute path to the herdctl state directory (.herdctl). */
  stateDir: string;
  /**
   * Absolute path to the generated herdctl.yaml that the FleetManager loads.
   * Paddock owns/regenerates this file (one keeper agent per project).
   */
  herdctlConfigPath: string;
  /** Absolute path to the built web SPA (served in production). */
  webDist: string;
  /**
   * Absolute path to the Claude home THIS INSTANCE owns — the directory whose
   * `projects/<encoded-cwd>/` folders hold Claude Code's session transcripts.
   * `<dataDir>/claude-home` unless an operator relocates it; paddock ALWAYS owns
   * it (#691) and refuses to start if it resolves to the user's own `~/.claude`.
   * See {@link resolveClaudeHome}.
   *
   * Resolved ONCE here (#588) rather than re-read from `process.env` at each call
   * site, because it must be the SAME value everywhere: paddock's transcript
   * relocation (`ensureProjectChats`) symlinks `<claudeHome>/projects/<encoded>`
   * at the project's `.chats/`, and the engine's session discovery / adoption
   * resolves transcripts under `FleetManagerOptions.claudeHomePath`. If paddock
   * honoured one home while the engine fell back to `os.homedir()/.claude`,
   * detection would scan one home while reads came from another — chats LIST but
   * open EMPTY (herdctl#423 / #588 gotcha 1). The divergence is invisible
   * whenever the two coincide, which is exactly why it is threaded explicitly
   * instead of being left to a shared default.
   */
  claudeHome: string;
  /**
   * Absolute path to the USER's own Claude home — always `os.homedir()/.claude`,
   * regardless of what {@link claudeHome} resolved to.
   *
   * This is a READ-ONLY source (#620), never a destination. Paddock consults it
   * for exactly two things: adoption (`~/.claude` is where a user's own Claude
   * Code CLI history lives, which #588 lets them import), and the user-level
   * config bridge (see `claude-home.ts`). Nothing in paddock moves or deletes
   * anything under it.
   */
  legacyClaudeHome: string;
  /**
   * What this instance shares with the host's Claude Code (#691) — currently
   * just `transcripts`. See {@link ClaudeConfig}.
   *
   * Replaces the derived `ownsClaudeHome` flag, which was the single lever every
   * distinct concern hung off. Paddock now always owns its home, so "may we
   * write here?" has one answer and the question that actually varies — whose
   * transcripts these are — is asked directly.
   */
  claude: ClaudeConfig;
  /** Provider-agnostic user-authentication config (see AUTH.md). */
  auth: AuthConfig;
  /** Voice-dictation (Whisper) capability (per-instance; default off). */
  transcription: TranscriptionConfig;
  /** Per-instance branding (title/logo/accent; defaults preserve today's look). */
  brand: BrandConfig;
  /**
   * OpenAPI / Swagger-UI reference (the `/open-api` docs + `/open-api.json`
   * spec, derived from the route schemas). `enabled` mounts or omits the whole
   * surface. Driven by `PADDOCK_OPENAPI_ENABLED` (1/true/yes/on enable);
   * default OFF (opt-in) — publishing the API surface map is a deliberate
   * choice. Gated by the instance auth mode like any other route when enabled.
   */
  openapi: OpenApiConfig;
  /**
   * Global default for how keeper chat turns are driven (Paddock#111), used when
   * a project doesn't override `driveMode`. `session` by default (#316) — the
   * persistent `openChatSession` path, so cross-turn autonomy (ScheduleWakeup /
   * `/loop`) and SDK streaming work out of the box; set
   * `PADDOCK_DRIVE_MODE=batch` for the legacy one-shot `trigger()` path.
   */
  driveMode: DriveMode;
  /**
   * The instance ALLOW-LIST of offered models (issue #457 Step 2), by catalog id
   * — which of the built-in {@link import("./models.js").MODELS} catalog the model
   * picker + per-project default offer. `undefined` (the default, when neither
   * `PADDOCK_MODELS` nor a YAML `models:` list is set) means "offer every catalog
   * model" — fully backward-compatible. When set it is a validated, de-duped subset
   * (unknown ids dropped; an empty result collapses back to the full catalog, so an
   * instance never offers zero models). The catalog itself stays the source of each
   * model's metadata and of {@link import("./models.js").isKnownModel}; this only
   * narrows what's OFFERED. Resolved to concrete {@link ModelInfo} via
   * {@link import("./models.js").resolveModels}. A per-project `models` override can
   * narrow it further (never widen beyond this list).
   */
  models?: string[];
  /**
   * Whether keeper agents use the native Claude Code system prompt +
   * project CLAUDE.md hierarchy (true, the default) instead of a terse Paddock
   * "replace" system prompt (false). Driven by `PADDOCK_NATIVE_PROMPT`.
   *
   * This is its own decision (issue #176) governing only which system prompt an
   * agent gets. When native (the default on every instance) Paddock sets NO
   * `system_prompt`, so 100% of an agent's standing instructions come from
   * Claude Code's own `CLAUDE.md` walk-up from its cwd — which is what makes the
   * cwd load-bearing. Set `PADDOCK_NATIVE_PROMPT=false` to fall back to
   * the terse replace prompt (e.g. an instance with no CLAUDE.md files).
   *
   * **The canonical instance-wide `CLAUDE.md` is `<projectsRoot>/CLAUDE.md`**
   * (issue #512). `projectsRoot` IS the instance's backing repo, so that file is
   * version-controlled and pushed with everything else, whereas a
   * `<dataDir>/CLAUDE.md` would sit outside the repo. It reaches every project
   * keeper by walk-up (a project dir is a child of `projectsRoot`) and the ROOT
   * keeper too — the root workspace's cwd IS `projectsRoot`. There is no longer
   * any agent whose cwd sits outside that tree, so every keeper picks the
   * instance CLAUDE.md up by walk-up. That closes #512.
   */
  nativeSystemPrompt: boolean;
  /**
   * The **environment** prompt appended to every keeper turn's system prompt
   * (issue #635) — the short note telling the agent it renders into a browser as
   * GFM, not a terminal. Resolved from `PADDOCK_ENVIRONMENT_PROMPT` over the
   * `environmentPrompt:` file key over
   * {@link import("./environment-prompt.js").DEFAULT_ENVIRONMENT_PROMPT}.
   *
   * This is the RESOLVED, effective text, so it has only two meaningful states
   * at the point of use: non-empty (append it) and `""` (append nothing — the
   * instance opted out). The three *authoring* states — unset, a string, an
   * empty string — collapse here, which is deliberate: every consumer just asks
   * "is there anything to append?" and the Settings screen shows the text that
   * is actually in force rather than a tri-state it would have to explain.
   *
   * Orthogonal to {@link nativeSystemPrompt}: that switch chooses the agent's
   * *role* prompt (native preset vs Paddock's terse replace text); this states
   * environmental fact about the deployment and applies on top of either.
   */
  environmentPrompt: string;
  /**
   * Whether keeper turns are handed the read-only self-management MCP server
   * (issue #214 Phase 1) — the `mcp__paddock_manage__*` tools that let a keeper
   * enumerate projects/chats and read another chat's transcript. Driven by
   * `PADDOCK_SELF_MCP`; default OFF (opt-in per instance). The write tools
   * (create/fork/message) are gated separately by
   * {@link selfMcpWriteEnabled}.
   */
  selfMcpEnabled: boolean;
  /**
   * Whether keepers additionally get the self-management MCP **write** tools
   * (issue #214 Phase 2) — `create_chat`, `fork_chat`, `send_message`,
   * `fork_chat_batch` (fan-out). Driven by `PADDOCK_SELF_MCP_WRITE`; default OFF
   * and only honored when {@link selfMcpEnabled} is also on (write implies read).
   * Gated behind its own flag because these START real keeper turns — an instance
   * can offer read-only introspection without the write blast radius.
   */
  selfMcpWriteEnabled: boolean;
  /**
   * Whether keepers additionally get the self-management MCP **project** tools
   * (issue #467) — `create_project`, which provisions a whole new project
   * (directory + `project.yaml`, optionally a cloned repo-backed checkout) and
   * registers its keeper agent. Driven by `PADDOCK_SELF_MCP_PROJECTS`; default OFF
   * and only honored when {@link selfMcpWriteEnabled} is also on (the tool lives in
   * the write block).
   *
   * Gated behind its OWN flag rather than folded into `selfMcpWriteEnabled` because
   * every other write tool acts WITHIN an existing project, whereas this one mutates
   * instance-level state (a new dir in the projects root, new long-lived agents) and
   * runs `git clone` on a CALLER-SUPPLIED url. It is an operator-intent boundary, not
   * a hard security one (a keeper with Bash in a write-enabled project can already
   * clone what it likes) — but provisioning infrastructure should be opt-in.
   */
  selfMcpProjectsEnabled: boolean;
  /**
   * Instance default for how deep a spawn tree may grow before spawned children
   * stop receiving the self-management MCP (issue #262 / DD-3). A spawned turn at
   * depth `d` gets the self-MCP (incl. write tools, so `send_message` exists and a
   * child can report back to its parent) iff `d <= maxSpawnDepth`. Driven by
   * `PADDOCK_MAX_SPAWN_DEPTH`; default {@link DEFAULT_MAX_SPAWN_DEPTH} (`1` — a
   * manager's direct children work, grandchildren are blocked). `0` restores
   * today's behaviour (no spawned child gets it). A per-project `maxSpawnDepth`
   * overrides this at dispatch (the `driveMode` pattern). Only meaningful when
   * {@link selfMcpWriteEnabled} is on — spawning needs the write tools.
   */
  maxSpawnDepth: number;
  /**
   * Per-deployment gate for programmatic schedule mutation (issue #265 / DD-7).
   * When ON, the FleetManager is constructed with `allowScheduleMutation: true`,
   * so herdctl's runtime schedule add/remove APIs (the
   * seam the D4 schedules UI calls) are permitted; OFF (default) makes them throw.
   * Declaring schedules statically in `project.yaml` is unaffected either way.
   * Driven by `PADDOCK_SCHEDULE_MUTATION`; accepts 1/true/yes.
   */
  scheduleMutationEnabled: boolean;
  /**
   * External Management API clients (issue #312 M1) — the `/mcp` surface for
   * callers OUTSIDE this instance (a laptop Claude Code session, a peer Paddock).
   *
   * Self-contained and INDEPENDENT of {@link auth}: `/mcp` authenticates itself,
   * so it stays credential-gated even at `auth.mode: none`, and needs no reverse
   * proxy. An EMPTY client list means the surface is off entirely and `/mcp`
   * 404s — the endpoint does not exist until deliberately configured.
   */
  managementApi: ManagementApiConfig;
  /**
   * Operator-facing problems found while resolving {@link managementApi} — a
   * malformed client (`errors`) or one dropped because its credential wouldn't
   * resolve (`warnings`). Carried on the config rather than logged at parse time
   * because config loading has no logger; app.ts logs these at boot.
   */
  managementApiDiagnostics: { errors: string[]; warnings: string[] };
  /**
   * MCP servers this instance declares for itself (#691 step 6), resolved from
   * the top-level `mcpServers:` block with every `env:VAR_NAME` reference read
   * from the environment. Every project's keeper is attached all of them, and
   * they win a name collision against anything inherited via
   * `claude.mcpServers: host`.
   *
   * **Holds resolved secret material** — an MCP server's `env` is where a stdio
   * server's API token lives — exactly as {@link managementApi}'s client tokens
   * do. It must never be serialised into an API response; `instance-config.ts`
   * publishes only the fields in its own `FIELDS` table, and this is
   * deliberately not one of them.
   */
  mcpServers: McpServerDefs;
  /**
   * Operator-facing problems found while resolving {@link mcpServers}: a
   * declaration paddock cannot carry (`errors`, server dropped) or one whose
   * `env:` reference did not resolve / whose secret is inlined (`warnings`).
   * Carried, not logged, for the same reason as
   * {@link managementApiDiagnostics}. Never contains a value from the block.
   */
  mcpServersDiagnostics: { errors: string[]; warnings: string[] };
  /**
   * Instance default for the hook-management MCP (Epic G / G5, GG-4) — now the
   * unified TRIGGER tools `mcp__paddock_manage__{list_triggers,set_trigger,
   * remove_trigger,run_trigger}` that let a project agent declare/edit/delete/fire
   * its own triggers. Epic T / T3 collapsed the former `*_hook` and `*_schedule`
   * verbs into these; the flag and its env var kept the `hooks` spelling.
   * A sibling of {@link selfMcpWriteEnabled}:
   * OFF by default (opt-in), and only surfaces when the self-MCP write tools are also
   * present (the trigger tools live on the same injected server, appended in the write
   * block). Driven by `PADDOCK_HOOKS_MCP`; accepts 1/true/yes. A per-project
   * `hooksMcpEnabled` override wins at dispatch (resolved via
   * {@link import("./hook-config.js").resolveHooksMcpEnabled}), the same
   * inherit/override discipline as `maxSpawnDepth`. The gate is BINARY access to the
   * MCP — an agent that has it can create hooks at any capability (GG-4: no
   * per-capability gating).
   */
  hooksMcpEnabled: boolean;
  /**
   * Keeper-chat recovery config (issue #301) — the two independently-toggleable
   * layers that unstick a keeper whose background task is killed at the turn
   * boundary (see recovery-config.ts / edspencer/herdctl#374). Instance defaults
   * here (`PADDOCK_RECOVERY_*` env, YAML beneath); a per-project `recovery`
   * override wins at dispatch via
   * {@link import("./recovery-config.js").resolveRecoveryConfig}. Layer 2
   * (`surfaceKilledTask`) defaults ON; Layer 3 (`autoReDrive`) defaults OFF.
   */
  recovery: RecoveryConfig;
  /**
   * Inbound composer-attachment config (issue #328) — whether users can upload
   * files/images into the composer, and the size/count/type caps. Instance
   * defaults here (`PADDOCK_ATTACHMENTS_*` env, YAML beneath); a per-project
   * `attachments` override wins at request time via
   * {@link import("./attachments-config.js").resolveAttachmentsConfig}. Enabled +
   * allow-all by default.
   */
  attachments: AttachmentsConfig;
  /**
   * Per-file token budgets the post-turn sweeper (curation) must keep its three
   * curated files under (issue #379). These bound the context every keeper chat
   * pays for — CHANGELOG.md + OVERVIEW.md are injected into the project-context
   * preload, and CLAUDE.md auto-loads every turn. The sweeper is told each budget
   * (so it prunes/dedups to fit) and `SweepService` enforces it as a backstop.
   * Instance defaults here (`PADDOCK_CURATION_*` env, YAML beneath).
   */
  curation: CurationConfig;
  /**
   * Log level for the server's structured logger (Fastify/pino). Driven by
   * `LOG_LEVEL`; default `info`.
   */
  logLevel: string;
  /**
   * Whether keeper agents receive the Playwright browser MCP server
   * (headless Chromium) so Claude Code can drive a browser (navigate / click /
   * snapshot / screenshot). Driven by `PADDOCK_BROWSER_MCP` (`1` enables);
   * default false. Scoped PER INSTANCE — a box without the browser stack leaves
   * it off so there are no failed spawns, and enabling it is a per-box env flip.
   */
  browserMcp: boolean;
  /**
   * Minimum ms between post-turn curation sweeps for a single project, or
   * `undefined` to use the SweepService default (5 min). Driven by
   * `PADDOCK_SWEEP_MIN_INTERVAL_MS`; a non-finite or negative value is ignored
   * (falls back to the default).
   */
  sweepMinIntervalMs?: number;
  /**
   * Git commit identity used when Paddock commits on a project's behalf, so no
   * global git config is needed. Driven by `PADDOCK_GIT_AUTHOR_NAME` /
   * `PADDOCK_GIT_AUTHOR_EMAIL`; defaults `Paddock` / `paddock@localhost`.
   */
  gitAuthor: { name: string; email: string };
  /**
   * The GitHub OAuth/App client id for the git-backing-store device flow
   * (github-auth.ts). Driven by `PADDOCK_GITHUB_CLIENT_ID`; `undefined` when
   * unset, in which case the GitHub connect feature reports "not configured".
   */
  githubClientId?: string;
}

/**
 * On-disk shape of the optional YAML instance-config file (issue #270 / DD-5).
 *
 * This is the BASE layer for {@link PaddockConfig}: every field is optional and
 * a matching `PADDOCK_*` env var still overrides it (precedence file < env), so
 * an env-only deployment is unaffected when no file is present. Values mirror
 * the resolved config's structure; scalars accept their natural YAML type (and
 * also a string, since each value is coerced through the same env-parsing path).
 * Unknown keys are ignored — later epics (schedules, hooks) will add their own
 * top-level record sections here.
 */
export interface PaddockConfigFile {
  /**
   * Which version of THIS format the file is written in (#724). Absent reads as
   * `1` — the shape every pre-adoption file already has — and a version newer
   * than `CONFIG_SCHEMA_VERSION` refuses the boot rather than being
   * lenient-parsed. See `schema-version.ts` for when to bump it.
   */
  schemaVersion?: number | string;
  /**
   * Posture profile (#878): `paranoid` | `balanced` | `yolo`. Expands to
   * defaults for the `claude:` modes, `maxSpawnDepth` and the capability
   * toggles; any of those set explicitly here or in the env still wins.
   * `PADDOCK_PROFILE` overrides this key. Absent ⇒ `balanced`.
   */
  profile?: string;
  port?: number | string;
  host?: string;
  dataDir?: string;
  projectsRoot?: string;
  stateDir?: string;
  herdctlConfigPath?: string;
  webDist?: string;
  /** Where paddock's OWN Claude home lives; beneath `CLAUDE_CONFIG_DIR` (#691). */
  claudeHome?: string;
  /**
   * What this instance shares with the host's Claude Code (#691). Each key takes
   * `own` or `host`; a matching `PADDOCK_CLAUDE_*` env var still overrides it
   * (file < env). Absent ⇒ fully isolated.
   */
  claude?: {
    transcripts?: string;
    credentials?: string;
    instructions?: string;
    hooks?: string;
    mcpServers?: string;
  };
  /**
   * MCP servers this instance declares for ITSELF (#691 step 6) — a sibling of
   * `claude:`, not a member of it, because it answers a different question:
   * `claude.mcpServers` borrows whatever this machine already has, while this
   * says what paddock should have regardless.
   *
   * File-only, like `managementApi`: a map of servers does not express as a
   * scalar env var. Token material belongs in the environment and is referenced
   * as `env:VAR_NAME` from any string here — see `mcp-servers.ts`.
   */
  mcpServers?: McpServersConfigFile;
  auth?: {
    mode?: string;
    userHeader?: string;
    emailHeader?: string;
    groupsHeader?: string;
    jwtHeader?: string;
    jwksUrl?: string;
    jwtIssuer?: string;
    jwtAudience?: string;
    usernameClaim?: string;
    groupsClaim?: string;
  };
  transcription?: {
    mode?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
    language?: string;
    maxUploadBytes?: number | string;
  };
  brand?: { name?: string; logo?: string; accent?: string };
  openapi?: { enabled?: boolean | string; path?: string };
  /**
   * Instance allow-list of offered models (issue #457 Step 2). A real array of
   * catalog ids (or a comma-separated string, coerced the same way); a matching
   * `PADDOCK_MODELS` env var (comma-separated) still overrides it (file < env).
   * Absent ⇒ every catalog model is offered (unchanged behaviour).
   */
  models?: string[] | string;
  driveMode?: string;
  nativeSystemPrompt?: boolean | string;
  /**
   * Environment system prompt override (issue #635). Absent ⇒ Paddock's built-in
   * text; a non-empty string ⇒ that text instead; an EMPTY string ⇒ append
   * nothing. Unlike almost every other key here, blank is meaningful and is NOT
   * folded to the default — see {@link loadEnvironmentPrompt}.
   */
  environmentPrompt?: string;
  selfMcpEnabled?: boolean | string;
  selfMcpWriteEnabled?: boolean | string;
  selfMcpProjectsEnabled?: boolean | string;
  maxSpawnDepth?: number | string;
  scheduleMutationEnabled?: boolean | string;
  hooksMcpEnabled?: boolean | string;
  /**
   * External Management API config (issue #312 M1). Token material is given as
   * an `env:VAR_NAME` REFERENCE — never inlined, because this file is
   * git-tracked. Absent ⇒ no external clients ⇒ `/mcp` 404s (fail closed).
   */
  managementApi?: ManagementApiConfigFile;
  /**
   * Keeper-chat recovery config (issue #301). Every field optional; a matching
   * `PADDOCK_RECOVERY_*` env var still overrides it (precedence file < env).
   */
  recovery?: {
    surfaceKilledTask?: boolean | string;
    autoReDrive?: boolean | string;
    debounceMs?: number | string;
    maxRetries?: number | string;
  };
  /**
   * Inbound composer-attachment config (issue #328). Every field optional; a
   * matching `PADDOCK_ATTACHMENTS_*` env var still overrides it (file < env).
   * `allowedTypes` is a real array here (env is comma-separated).
   */
  attachments?: {
    enabled?: boolean | string;
    maxFileSizeMb?: number | string;
    maxFilesPerMessage?: number | string;
    allowedTypes?: string[] | string;
  };
  /**
   * Per-file curation token budgets (issue #379). Every field optional; a
   * matching `PADDOCK_CURATION_*` env var still overrides it (file < env).
   */
  curation?: {
    overviewMaxTokens?: number | string;
    changelogMaxTokens?: number | string;
    claudeMaxTokens?: number | string;
  };
  logLevel?: string;
  browserMcp?: boolean | string;
  sweepMinIntervalMs?: number | string;
  gitAuthor?: { name?: string; email?: string };
  githubClientId?: string;
}

/**
 * Voice-dictation (Whisper) capability. Mirrors HushPod's whisper config so the
 * two can share a transcription backend (e.g. Ed's laptop whisper server). Driven
 * entirely by `PADDOCK_WHISPER_*` env so it is scoped PER INSTANCE and defaults
 * to `off` — a plain instance advertises no mic button.
 *
 * - `off`    — dictation disabled (default). No mic button in the composer.
 * - `remote` — POST audio to an OpenAI-compatible `/audio/transcriptions`
 *              endpoint (e.g. `http://whisper.local:8385/v1`). The same kind of
 *              server HushPod points at.
 * - `local`  — run whisper.cpp on this box via nodejs-whisper (CPU; slower).
 */
export type WhisperMode = "off" | "local" | "remote";

export interface TranscriptionConfig {
  /** Dictation backend. `off` disables the composer mic button. */
  mode: WhisperMode;
  /** Whisper model name (e.g. `base`, `base.en`, `small`). */
  model: string;
  /**
   * remote: OpenAI-compatible base URL, e.g. `http://whisper.local:8385/v1`.
   * `/audio/transcriptions` is appended. Required in `remote` mode.
   */
  endpoint?: string;
  /** remote: optional bearer token sent as `Authorization: Bearer …`. */
  apiKey?: string;
  /** Optional spoken-language hint (ISO-639-1, e.g. `en`). Unset ⇒ auto-detect. */
  language?: string;
  /** Max accepted upload size in bytes (guards the transcribe route). */
  maxUploadBytes: number;
}

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Canonicalize a path: resolve symlinks in the deepest EXISTING ancestor, then
 * re-append the not-yet-created tail. This matters because Claude Code records
 * session transcripts under the *real* working directory (e.g. macOS maps
 * `/tmp` -> `/private/tmp`), and SessionDiscoveryService encodes the configured
 * working_directory to find them. Without canonicalization the configured path
 * and the recorded path diverge and session discovery returns nothing.
 *
 * On Linux (the deploy target) this is typically a no-op, but it keeps paddock
 * portable and robust against symlinked data roots.
 */
function canonical(p: string): string {
  const absolute = abs(p);
  let dir = absolute;
  const tail: string[] = [];
  // Walk up to the first existing ancestor.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return absolute; // reached root without resolving
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : fallback;
}

/** An env var's trimmed value, or undefined when unset/blank. */
function envOpt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Fold a config-file value in as the fallback beneath a hardcoded default. The
 * file value is stringified — so the exact same parsing/coercion an env value
 * would get applies — and used when present and non-blank; otherwise the
 * hardcoded default. Env still wins because callers pass the result as the
 * `envOr` fallback (which is only consulted when the env var is unset).
 */
function fileOr(fileVal: unknown, fallback: string): string {
  if (fileVal === undefined || fileVal === null) return fallback;
  const s = String(fileVal);
  return s.trim().length > 0 ? s : fallback;
}

/** A config-file value as a trimmed string, or undefined when absent/blank. */
function fileOpt(fileVal: unknown): string | undefined {
  if (fileVal === undefined || fileVal === null) return undefined;
  const s = String(fileVal).trim();
  return s.length > 0 ? s : undefined;
}

/** Default filename for the instance-config file, resolved under the data dir. */
const DEFAULT_CONFIG_FILENAME = "paddock.config.yaml";

/**
 * Load the optional YAML instance-config file that provides the BASE layer for
 * {@link PaddockConfig} (issue #270 / DD-5). Env vars still override every value
 * (precedence file < env).
 *
 * Path resolution: an explicit `PADDOCK_CONFIG` env var wins; otherwise
 * `<dataDir>/paddock.config.yaml`. When no file exists at the default location
 * the result is an empty object, so an env-only deployment behaves exactly as
 * before — this is a no-op for existing installs. An explicit `PADDOCK_CONFIG`
 * that points at a missing file is treated as a misconfiguration (a clear error)
 * rather than silently ignored.
 *
 * A present-but-malformed file (unparseable YAML, or a top-level scalar/list
 * instead of a mapping) throws a clear Error rather than starting up with a
 * half-empty config.
 */
export function loadConfigFile(dataDir: string): PaddockConfigFile {
  const explicit = envOpt("PADDOCK_CONFIG");
  const configPath = explicit ? abs(explicit) : path.join(dataDir, DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Missing default file → env-only, unchanged behaviour. A missing file
      // that was EXPLICITLY requested is an operator error worth surfacing.
      if (explicit) {
        throw new Error(`PADDOCK_CONFIG points at a config file that does not exist: ${configPath}`);
      }
      return {};
    }
    throw new Error(`Failed to read Paddock config file ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse Paddock config file ${configPath} as YAML: ${(err as Error).message}`,
    );
  }

  // An empty (or comments-only) file parses to null → treat as "no overrides".
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Paddock config file ${configPath} must contain a YAML mapping (got ${
        Array.isArray(parsed) ? "a list" : typeof parsed
      }).`,
    );
  }

  // A valueless key (`brand:` / `auth:` with nothing after it) parses to `null`.
  // Treat such an empty section (or scalar) as ABSENT — drop it so it falls back
  // to env/defaults — rather than passing `null` through to a loader that expects
  // an object (which would crash with an unclear TypeError). Deeper `null`s and
  // wrong-typed sections already degrade to defaults via fileOr/fileOpt.
  const obj = parsed as Record<string, unknown>;

  // The downgrade guard (#724), BEFORE any lenient interpretation below. A file
  // from the future must never be half-read: every unknown key here is dropped,
  // and `writeInstanceConfig` would then persist the loss. Fail closed, exactly
  // as `resolveClaudeHome` does.
  const refusal = configSchemaRefusal(obj[SCHEMA_VERSION_KEY], configPath);
  if (refusal !== undefined) throw new Error(refusal);

  for (const key of Object.keys(obj)) {
    if (obj[key] === null) delete obj[key];
  }
  return obj as PaddockConfigFile;
}

/**
 * Resolve the provider-agnostic auth config from `PADDOCK_AUTH_*` env vars.
 * Everything is optional; the default is `none` (fully open). Validation of
 * mode-specific requirements (e.g. a JWKS URL in jwt mode) happens in the auth
 * plugin so a misconfig surfaces as a clear startup error rather than a
 * silently-open server.
 */
function loadAuthConfig(file: PaddockConfigFile["auth"] = {}): AuthConfig {
  const rawMode = envOr("PADDOCK_AUTH_MODE", fileOr(file.mode, "none")).toLowerCase();
  const mode: AuthMode =
    rawMode === "trusted-header" || rawMode === "jwt" ? rawMode : "none";

  return {
    mode,
    userHeader: envOr("PADDOCK_AUTH_USER_HEADER", fileOr(file.userHeader, "X-Forwarded-User")),
    emailHeader: envOpt("PADDOCK_AUTH_EMAIL_HEADER") ?? fileOpt(file.emailHeader),
    groupsHeader: envOpt("PADDOCK_AUTH_GROUPS_HEADER") ?? fileOpt(file.groupsHeader),
    jwtHeader: envOr("PADDOCK_AUTH_JWT_HEADER", fileOr(file.jwtHeader, "Authorization")),
    jwksUrl: envOpt("PADDOCK_AUTH_JWKS_URL") ?? fileOpt(file.jwksUrl),
    jwtIssuer: envOpt("PADDOCK_AUTH_JWT_ISSUER") ?? fileOpt(file.jwtIssuer),
    jwtAudience: envOpt("PADDOCK_AUTH_JWT_AUDIENCE") ?? fileOpt(file.jwtAudience),
    usernameClaim: envOpt("PADDOCK_AUTH_USERNAME_CLAIM") ?? fileOpt(file.usernameClaim),
    groupsClaim: envOr("PADDOCK_AUTH_GROUPS_CLAIM", fileOr(file.groupsClaim, "groups")),
  };
}

/**
 * Resolve the dangerously-open opt-in from `PADDOCK_DANGEROUSLY_ALLOW_OPEN`
 * (#435). Off by default; accepts the shared 1/true/yes truthy convention. When
 * set, the bind-safety guard downgrades its refusal (non-loopback + auth=none)
 * to a loud boot warning instead of failing closed.
 */
function loadDangerouslyAllowOpen(): boolean {
  const raw = envOr("PADDOCK_DANGEROUSLY_ALLOW_OPEN", "false").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the voice-dictation (Whisper) capability from env. Defaults to `off`,
 * so a plain instance never shows a mic button. The mode defaults to `remote`
 * when an endpoint is configured (the common case — point it at a shared whisper
 * server), and can be forced with `PADDOCK_WHISPER_MODE`. Accepts local/remote/off.
 */
function loadTranscriptionConfig(file: PaddockConfigFile["transcription"] = {}): TranscriptionConfig {
  const endpoint = envOpt("PADDOCK_WHISPER_ENDPOINT") ?? fileOpt(file.endpoint);
  const rawMode = envOr(
    "PADDOCK_WHISPER_MODE",
    fileOr(file.mode, endpoint ? "remote" : "off"),
  ).toLowerCase();
  const mode: WhisperMode = rawMode === "local" || rawMode === "remote" ? rawMode : "off";
  return {
    mode,
    model: envOr("PADDOCK_WHISPER_MODEL", fileOr(file.model, "base")),
    endpoint,
    apiKey: envOpt("PADDOCK_WHISPER_API_KEY") ?? fileOpt(file.apiKey),
    language: envOpt("PADDOCK_WHISPER_LANGUAGE") ?? fileOpt(file.language),
    maxUploadBytes: Number(
      envOr("PADDOCK_WHISPER_MAX_UPLOAD_BYTES", fileOr(file.maxUploadBytes, String(25 * 1024 * 1024))),
    ),
  };
}

/**
 * Resolve per-instance branding from env. Defaults preserve today's look, so a
 * plain instance is unchanged; an operator running several instances from one
 * image sets `PADDOCK_BRAND_*` in each instance's env to tell them apart.
 */
function loadBrandConfig(file: PaddockConfigFile["brand"] = {}): BrandConfig {
  return {
    name: envOr("PADDOCK_BRAND_NAME", fileOr(file.name, "Paddock")),
    logo: envOr("PADDOCK_BRAND_LOGO", fileOr(file.logo, "🐎")),
    accent: envOr("PADDOCK_BRAND_ACCENT", fileOr(file.accent, "#c2603c")),
  };
}

/**
 * Default location of the built web SPA, resolved RELATIVE TO THIS MODULE:
 * `packages/server/{src,dist}/config.js` -> `packages/web/dist`. The same hop
 * works from both the `tsx src/` and `node dist/` layouts, so neither needs a
 * `PADDOCK_WEB_DIST` override.
 *
 * Takes the module URL as a parameter purely so a test can exercise install
 * paths this repo's own checkout does not have.
 *
 * **`fileURLToPath`, NOT `new URL(url).pathname`.** The raw pathname is
 * percent-ENCODED, so an install path containing a space or any non-ASCII
 * character (`/opt/my paddock/`, `~/Développement/`) yields a literal `%20`
 * that resolves to a directory which does not exist. The failure is SILENT:
 * `app.ts` degrades to API-only mode with only a log warning, so the user gets
 * a blank page and no explanation of why. `fileURLToPath` also decodes the
 * `/C:/...` drive-letter form on Windows. This is irrelevant when the path is
 * the Docker image's fixed `/app`, and load-bearing the moment the package is
 * installed under an arbitrary user directory (`npx`, global install).
 */
export function resolveDefaultWebDist(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../web/dist");
}

export function loadPaddockConfig(): PaddockConfig {
  // The optional YAML instance-config file provides the BASE layer; env vars
  // override it (precedence file < env). The file is located under the data dir,
  // so resolve a BOOTSTRAP data dir from env/default first to find it — the file
  // may then re-base the data dir for the resolved config below.
  const bootstrapDataDir = abs(envOr("PADDOCK_DATA_DIR", "./data"));
  const file = loadConfigFile(bootstrapDataDir);

  // Ensure the data root exists first so symlinks (e.g. /tmp -> /private/tmp on
  // macOS) resolve consistently for every derived path below.
  const dataRoot = abs(envOr("PADDOCK_DATA_DIR", fileOr(file.dataDir, "./data")));
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch {
    /* best-effort; downstream mkdirs will surface real errors */
  }
  // working_directory of keeper agents MUST be canonical so session discovery
  // (which encodes the real path) can find Claude transcripts.
  const dataDir = canonical(dataRoot);
  const projectsRoot = canonical(
    envOr("PADDOCK_PROJECTS_DIR", fileOr(file.projectsRoot, path.join(dataRoot, "projects"))),
  );
  const stateDir = canonical(
    envOr("PADDOCK_STATE_DIR", fileOr(file.stateDir, path.join(dataRoot, ".herdctl"))),
  );
  const herdctlConfigPath = canonical(
    envOr("PADDOCK_HERDCTL_CONFIG", fileOr(file.herdctlConfigPath, path.join(dataRoot, "herdctl.yaml"))),
  );
  // The ONE Claude home for this process (#588): paddock's transcript symlinks,
  // the engine's session discovery and session adoption all resolve against this
  // exact value — which herdctl in turn hands Claude Code as `CLAUDE_CONFIG_DIR`.
  // Defaults to `<dataDir>/claude-home` (#620); see `resolveClaudeHome`.
  const resolvedClaudeHome = resolveClaudeHome(dataDir, fileOpt(file.claudeHome));
  const legacyClaudeHome = userClaudeHome();

  const defaultWebDist = resolveDefaultWebDist(import.meta.url);

  // The posture profile (#878), resolved BEFORE the levers it supplies defaults
  // for. It is not a config layer of its own: `p` is handed to each posture
  // loader as the fallback that used to be a hardcoded literal, so an individual
  // file key or env var still wins over it. See `profiles.ts` for why an
  // individual FILE key deliberately beats `PADDOCK_PROFILE` in the env.
  const profile = resolveProfileName(file.profile);
  const p = postureFor(profile);

  return Object.freeze({
    profile,
    port: Number(envOr("PORT", fileOr(file.port, "7233"))),
    // Safe by default (#435): bind loopback unless explicitly told otherwise, so
    // a fresh source/tarball run is network-closed. Non-loopback + no auth is then
    // gated by the bind-safety guard (see bind-safety.ts). Existing deployments
    // that set HOST/PADDOCK_HOST are unaffected — only the DEFAULT changed from
    // 0.0.0.0. (The container image keeps ENV HOST=0.0.0.0: the network namespace
    // is its boundary and Docker can't reach 127.0.0.1 inside the container.)
    host: envOr("HOST", envOr("PADDOCK_HOST", fileOr(file.host, "127.0.0.1"))),
    dangerouslyAllowOpen: loadDangerouslyAllowOpen(),
    dataDir,
    projectsRoot,
    stateDir,
    herdctlConfigPath,
    webDist: abs(envOr("PADDOCK_WEB_DIST", fileOr(file.webDist, defaultWebDist))),
    claudeHome: resolvedClaudeHome,
    legacyClaudeHome,
    claude: loadClaudeConfig(file.claude, p),
    auth: loadAuthConfig(file.auth),
    transcription: loadTranscriptionConfig(file.transcription),
    brand: loadBrandConfig(file.brand),
    models: loadModels(file.models),
    driveMode: loadDriveMode(file.driveMode),
    nativeSystemPrompt: loadNativeSystemPrompt(file.nativeSystemPrompt),
    environmentPrompt: loadEnvironmentPrompt(file.environmentPrompt),
    selfMcpEnabled: loadSelfMcpEnabled(file.selfMcpEnabled, p.selfMcpEnabled),
    selfMcpWriteEnabled:
      loadSelfMcpEnabled(file.selfMcpEnabled, p.selfMcpEnabled) &&
      loadSelfMcpWriteEnabled(file.selfMcpWriteEnabled, p.selfMcpWriteEnabled),
    // Projects tool implies write implies read — the tool is appended in the write
    // block, so both outer gates must be on for it to mean anything (issue #467).
    // The cascade is why a profile's three self-MCP values are never read in
    // isolation: `profile: yolo` plus an explicit `selfMcpEnabled: false`
    // correctly collapses write and projects too.
    selfMcpProjectsEnabled:
      loadSelfMcpEnabled(file.selfMcpEnabled, p.selfMcpEnabled) &&
      loadSelfMcpWriteEnabled(file.selfMcpWriteEnabled, p.selfMcpWriteEnabled) &&
      loadSelfMcpProjectsEnabled(file.selfMcpProjectsEnabled, p.selfMcpProjectsEnabled),
    maxSpawnDepth: loadMaxSpawnDepth(file.maxSpawnDepth, p.maxSpawnDepth),
    scheduleMutationEnabled: loadScheduleMutationEnabled(
      file.scheduleMutationEnabled,
      p.scheduleMutationEnabled,
    ),
    ...(() => {
      // #312 M1: resolved against the real environment (token material is only
      // ever an `env:` reference). Diagnostics ride along for app.ts to log.
      const { config, errors, warnings } = resolveManagementApiConfig(
        file.managementApi,
        process.env,
      );
      return { managementApi: config, managementApiDiagnostics: { errors, warnings } };
    })(),
    ...(() => {
      // #691 step 6: file-only, and resolved against the real environment because
      // any string in the block may be an `env:VAR_NAME` reference. Diagnostics
      // ride along for app.ts to log — they never carry a resolved value.
      const { servers, errors, warnings } = resolveDeclaredMcpServers(file.mcpServers, process.env);
      return { mcpServers: servers, mcpServersDiagnostics: { errors, warnings } };
    })(),
    hooksMcpEnabled: loadHooksMcpEnabled(file.hooksMcpEnabled, p.hooksMcpEnabled),
    recovery: loadRecoveryConfig(file.recovery),
    attachments: loadAttachmentsConfig(file.attachments),
    curation: loadCurationConfig(file.curation),
    logLevel: envOr("LOG_LEVEL", fileOr(file.logLevel, "info")),
    browserMcp: loadBrowserMcp(file.browserMcp, p.browserMcp),
    openapi: loadOpenApiConfig(file.openapi),
    sweepMinIntervalMs: loadSweepMinIntervalMs(file.sweepMinIntervalMs),
    gitAuthor: {
      name: envOr("PADDOCK_GIT_AUTHOR_NAME", fileOr(file.gitAuthor?.name, "Paddock")),
      email: envOr("PADDOCK_GIT_AUTHOR_EMAIL", fileOr(file.gitAuthor?.email, "paddock@localhost")),
    },
    githubClientId: envOpt("PADDOCK_GITHUB_CLIENT_ID") ?? fileOpt(file.githubClientId),
  });
}

// CurationConfig + DEFAULT_CURATION now live in ./curation-config.ts (issue #384),
// alongside the per-project override resolver — mirroring recovery-config.ts.

/** Resolve one positive-integer budget from env < file < built-in default. */
function loadCurationNum(
  envName: string,
  file: number | string | undefined,
  def: number,
): number {
  const raw = envOpt(envName) ?? fileOpt(file);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Resolve the curation token budgets (issue #379), precedence env < file < default. */
function loadCurationConfig(file?: PaddockConfigFile["curation"]): CurationConfig {
  return {
    overviewMaxTokens: loadCurationNum(
      "PADDOCK_CURATION_OVERVIEW_MAX_TOKENS",
      file?.overviewMaxTokens,
      DEFAULT_CURATION.overviewMaxTokens,
    ),
    changelogMaxTokens: loadCurationNum(
      "PADDOCK_CURATION_CHANGELOG_MAX_TOKENS",
      file?.changelogMaxTokens,
      DEFAULT_CURATION.changelogMaxTokens,
    ),
    claudeMaxTokens: loadCurationNum(
      "PADDOCK_CURATION_CLAUDEMD_MAX_TOKENS",
      file?.claudeMaxTokens,
      DEFAULT_CURATION.claudeMaxTokens,
    ),
  };
}

/**
 * Resolve the post-turn sweep's minimum interval from
 * `PADDOCK_SWEEP_MIN_INTERVAL_MS` (issue #269 fold). Returns `undefined` when
 * unset or invalid (non-finite / negative) so the SweepService default (5 min)
 * applies — preserving the pre-fold `envIntervalMs()` semantics exactly.
 */
function loadSweepMinIntervalMs(file?: PaddockConfigFile["sweepMinIntervalMs"]): number | undefined {
  const raw = envOpt("PADDOCK_SWEEP_MIN_INTERVAL_MS") ?? fileOpt(file);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve whether keeper agents receive the Playwright browser MCP
 * (issue #269 fold). The env var keeps its exact literal-'1' semantics (any
 * other set value — including `true` — disables it, matching pre-loader
 * behaviour); only when the env var is UNSET does the config file provide the
 * base, using the 1/true/yes convention shared by the other boolean knobs.
 */
function loadBrowserMcp(file: PaddockConfigFile["browserMcp"], fallback: boolean): boolean {
  const env = process.env.PADDOCK_BROWSER_MCP;
  if (env !== undefined) return env === "1";
  const raw = fileOpt(file)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the OpenAPI reference config. `enabled` defaults OFF (opt-in):
 * publishing the API surface is a deliberate choice, so it only mounts when
 * `PADDOCK_OPENAPI_ENABLED` / YAML is a truthy value (1/true/yes/on). `path`
 * (the UI route prefix) defaults `/open-api`; it is normalized to a leading
 * slash with no trailing slash.
 */
function loadOpenApiConfig(file?: PaddockConfigFile["openapi"]): OpenApiConfig {
  const rawEnabled = (
    process.env.PADDOCK_OPENAPI_ENABLED ??
    (file?.enabled === undefined ? undefined : String(file.enabled))
  )?.toLowerCase();
  const enabled =
    rawEnabled === "1" || rawEnabled === "true" || rawEnabled === "yes" || rawEnabled === "on";

  let path = envOpt("PADDOCK_OPENAPI_PATH") ?? fileOpt(file?.path) ?? "/open-api";
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  return { enabled, path };
}

/**
 * Resolve the instance-default max spawn depth from `PADDOCK_MAX_SPAWN_DEPTH`
 * (issue #262). Defaults to {@link DEFAULT_MAX_SPAWN_DEPTH} (`1`); a
 * missing/blank/out-of-range value falls back to the default rather than failing
 * startup. A per-project override still wins at dispatch.
 */
function loadMaxSpawnDepth(file: PaddockConfigFile["maxSpawnDepth"], fallback: number): number {
  const raw = envOpt("PADDOCK_MAX_SPAWN_DEPTH") ?? fileOpt(file);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return isValidMaxSpawnDepth(n) ? n : fallback;
}

/**
 * Resolve a boolean recovery knob (issue #301) with the shared 1/true/yes
 * convention, env over file over the built-in default. Mirrors the other boolean
 * loaders; factored so each recovery flag reads identically.
 */
function loadRecoveryBool(env: string, file: unknown, fallback: boolean): boolean {
  const raw = envOr(env, fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve a non-negative-integer recovery knob (issue #301). A missing/blank/
 * non-finite/negative value falls back to the default rather than failing
 * startup — defensive, like {@link loadMaxSpawnDepth}.
 */
function loadRecoveryInt(env: string, file: unknown, fallback: number): number {
  const raw = envOpt(env) ?? fileOpt(file);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the instance-default keeper-chat recovery config (issue #301). Layer 2
 * (`surfaceKilledTask`) defaults ON, Layer 3 (`autoReDrive`) defaults OFF; the
 * guards default per {@link DEFAULT_RECOVERY}. Each field is env-over-file-over-
 * default, and a per-project `recovery` override still wins at dispatch
 * (resolveRecoveryConfig). Malformed values degrade to the default, never fatal.
 */
function loadRecoveryConfig(file?: PaddockConfigFile["recovery"]): RecoveryConfig {
  const f = file ?? {};
  return {
    surfaceKilledTask: loadRecoveryBool(
      "PADDOCK_RECOVERY_SURFACE",
      f.surfaceKilledTask,
      DEFAULT_RECOVERY.surfaceKilledTask,
    ),
    autoReDrive: loadRecoveryBool(
      "PADDOCK_RECOVERY_AUTODRIVE",
      f.autoReDrive,
      DEFAULT_RECOVERY.autoReDrive,
    ),
    debounceMs: loadRecoveryInt(
      "PADDOCK_RECOVERY_DEBOUNCE_MS",
      f.debounceMs,
      DEFAULT_RECOVERY.debounceMs,
    ),
    maxRetries: loadRecoveryInt(
      "PADDOCK_RECOVERY_MAX_RETRIES",
      f.maxRetries,
      DEFAULT_RECOVERY.maxRetries,
    ),
  };
}

/**
 * Resolve a positive-integer attachment knob (issue #328). A missing/blank/
 * non-integer/< 1 value falls back to the default rather than failing startup —
 * defensive, like {@link loadRecoveryInt} (but size/count must be ≥ 1).
 */
function loadAttachmentsInt(env: string, file: unknown, fallback: number): number {
  const raw = envOpt(env) ?? fileOpt(file);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * Resolve the `allowedTypes` list (issue #328). The env var is comma-separated
 * (`PADDOCK_ATTACHMENTS_ALLOWED_TYPES=image/*,.pdf`); the YAML file takes a real
 * array (or a comma-separated string, coerced the same way). An empty/invalid
 * value falls back to the default (allow-all) — never "deny all".
 */
function loadAllowedTypes(file: string[] | string | undefined, fallback: string[]): string[] {
  const env = envOpt("PADDOCK_ATTACHMENTS_ALLOWED_TYPES");
  const raw: unknown =
    env !== undefined ? env.split(",") : Array.isArray(file) ? file : typeof file === "string" ? file.split(",") : undefined;
  return sanitizeAllowedTypes(raw) ?? fallback;
}

/**
 * Resolve the instance-default inbound-attachment config (issue #328). Enabled +
 * allow-all by default; each field is env-over-file-over-default, and a
 * per-project `attachments` override still wins at request time
 * (resolveAttachmentsConfig). Malformed values degrade to the default, never fatal.
 */
function loadAttachmentsConfig(file?: PaddockConfigFile["attachments"]): AttachmentsConfig {
  const f = file ?? {};
  const enabledRaw = envOr(
    "PADDOCK_ATTACHMENTS_ENABLED",
    fileOr(f.enabled, String(DEFAULT_ATTACHMENTS.enabled)),
  ).toLowerCase();
  return {
    enabled: enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes",
    maxFileSizeMb: loadAttachmentsInt(
      "PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB",
      f.maxFileSizeMb,
      DEFAULT_ATTACHMENTS.maxFileSizeMb,
    ),
    maxFilesPerMessage: loadAttachmentsInt(
      "PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE",
      f.maxFilesPerMessage,
      DEFAULT_ATTACHMENTS.maxFilesPerMessage,
    ),
    allowedTypes: loadAllowedTypes(f.allowedTypes, DEFAULT_ATTACHMENTS.allowedTypes),
  };
}

/**
 * Resolve the per-deployment schedule-mutation gate (issue #265 / DD-7). Defaults
 * OFF so a plain instance can't have its schedules mutated programmatically; an
 * operator opts in with `PADDOCK_SCHEDULE_MUTATION=1` (or the config file). Accepts
 * 1/true/yes. Static `project.yaml` schedules are armed regardless of this flag.
 */
function loadScheduleMutationEnabled(
  file: PaddockConfigFile["scheduleMutationEnabled"],
  fallback: boolean,
): boolean {
  const raw = envOr("PADDOCK_SCHEDULE_MUTATION", fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}


/**
 * Resolve the instance-default hook-management MCP gate (Epic G / G5, GG-4).
 * Defaults OFF so a plain instance never advertises the hook tools; opt in with
 * `PADDOCK_HOOKS_MCP=1` (or the config file), and a per-project `hooksMcpEnabled`
 * override still wins at dispatch. Accepts 1/true/yes. Only meaningful when the
 * self-MCP write tools are also enabled (the hook tools live on that server).
 */
function loadHooksMcpEnabled(
  file: PaddockConfigFile["hooksMcpEnabled"],
  fallback: boolean,
): boolean {
  const raw = envOr("PADDOCK_HOOKS_MCP", fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keepers additionally get the self-management MCP WRITE tools
 * (issue #214 Phase 2). Defaults OFF; only takes effect when `PADDOCK_SELF_MCP`
 * is also on (write implies read — enforced at the call site above). Accepts
 * 1/true/yes.
 */
function loadSelfMcpWriteEnabled(
  file: PaddockConfigFile["selfMcpWriteEnabled"],
  fallback: boolean,
): boolean {
  const raw = envOr("PADDOCK_SELF_MCP_WRITE", fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keepers additionally get the self-management MCP PROJECT tools
 * (issue #467 — `create_project`). Defaults OFF; only takes effect when
 * `PADDOCK_SELF_MCP` and `PADDOCK_SELF_MCP_WRITE` are also on (enforced at the call
 * site above). Accepts 1/true/yes.
 */
function loadSelfMcpProjectsEnabled(
  file: PaddockConfigFile["selfMcpProjectsEnabled"],
  fallback: boolean,
): boolean {
  const raw = envOr("PADDOCK_SELF_MCP_PROJECTS", fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keepers get the read-only self-management MCP (issue #214).
 * Defaults to OFF so a plain instance never advertises it; opt in per instance
 * with `PADDOCK_SELF_MCP=1`. Accepts 1/true/yes.
 */
function loadSelfMcpEnabled(
  file: PaddockConfigFile["selfMcpEnabled"],
  fallback: boolean,
): boolean {
  const raw = envOr("PADDOCK_SELF_MCP", fileOr(file, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keeper agents use the native system prompt + CLAUDE.md
 * hierarchy (issue #176). Defaults to `true` (native) on every instance so a
 * seeded instance-wide + per-project `CLAUDE.md` is auto-loaded; set
 * `PADDOCK_NATIVE_PROMPT` to 0/false/no to fall back to the terse replace
 * prompt.
 */
function loadNativeSystemPrompt(file?: PaddockConfigFile["nativeSystemPrompt"]): boolean {
  const raw = envOr("PADDOCK_NATIVE_PROMPT", fileOr(file, "true")).toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}

/**
 * Resolve the environment system prompt (issue #635): env
 * `PADDOCK_ENVIRONMENT_PROMPT` over the `environmentPrompt:` file key over the
 * built-in {@link DEFAULT_ENVIRONMENT_PROMPT}.
 *
 * Deliberately does NOT use `envOr`/`fileOr`. Those fold a blank value to the
 * fallback, which would make opting out impossible — blank is the opt-out here,
 * so precedence is decided on *definedness*, not on emptiness:
 *
 *  - `PADDOCK_ENVIRONMENT_PROMPT` **defined at all** (even empty) wins outright.
 *    That is why the field is declared `envShadowWhenDefined` in
 *    instance-config.ts — same rule as `PADDOCK_BROWSER_MCP` — so the Settings
 *    screen renders it read-only in exactly the cases where it really is.
 *  - Otherwise a `string` file value wins, empty included. A non-string (a YAML
 *    number, a mapping, `null` from a bare `environmentPrompt:`) is ignored
 *    rather than stringified — `"null"` is not a prompt anyone meant to write.
 *  - Otherwise the built-in default.
 *
 * The value is used verbatim: no trimming, no normalization. An operator's
 * trailing newline or leading indentation survives the round-trip, because the
 * text is going into a prompt where whitespace is content.
 */
function loadEnvironmentPrompt(file?: PaddockConfigFile["environmentPrompt"]): string {
  const env = process.env.PADDOCK_ENVIRONMENT_PROMPT;
  if (env !== undefined) return env;
  if (typeof file === "string") return file;
  return DEFAULT_ENVIRONMENT_PROMPT;
}

/**
 * Resolve the instance model allow-list (issue #457 Step 2), precedence
 * env `PADDOCK_MODELS` (comma-separated ids) over YAML `models:` (a string array,
 * or a comma-separated string coerced the same way) over the default (undefined ⇒
 * every catalog model is offered). Each id is validated against the catalog with
 * {@link isKnownModel}; unknown/blank/duplicate ids are dropped. If nothing valid
 * survives — or the list was unset — the result is `undefined`, which downstream
 * ({@link import("./models.js").resolveModels}) treats as "offer the full catalog",
 * so an instance is never left with zero models.
 */
function loadModels(file?: PaddockConfigFile["models"]): string[] | undefined {
  const env = envOpt("PADDOCK_MODELS");
  const raw: string[] | undefined =
    env !== undefined
      ? env.split(",")
      : Array.isArray(file)
        ? file.map((v) => String(v))
        : typeof file === "string"
          ? file.split(",")
          : undefined;
  if (raw === undefined) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    const id = item.trim();
    if (!id || seen.has(id) || !isKnownModel(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // Empty after filtering (all unknown/blank) ⇒ fall back to the full catalog.
  return ids.length > 0 ? ids : undefined;
}

/**
 * Resolve the global keeper drive mode from `PADDOCK_DRIVE_MODE`. Defaults
 * to `session` (DEFAULT_DRIVE_MODE, #316); an unrecognized value falls back
 * to the default rather than failing startup. A per-project `driveMode` still
 * overrides this at dispatch.
 */
function loadDriveMode(file?: PaddockConfigFile["driveMode"]): DriveMode {
  const raw = (envOpt("PADDOCK_DRIVE_MODE") ?? fileOpt(file))?.toLowerCase();
  return raw && isKnownDriveMode(raw) ? raw : DEFAULT_DRIVE_MODE;
}

/**
 * The USER's own Claude home — `~/.claude`, always. A read-only source for
 * adoption and the user-config bridge, never a destination (#620).
 *
 * Stays a function (not a constant) because `os.homedir()` must be read at call
 * time — tests and processes that mutate `HOME` depend on that.
 */
export function userClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * Resolve what this instance shares with the host's Claude Code (#691).
 *
 * Precedence is the file's usual env > file > default. An unrecognised value
 * falls back to the default rather than failing the boot — the same rule every
 * other enum here follows (`driveMode`, whisper `mode`). For `transcripts` that
 * is also the safe direction: a typo isolates rather than silently sharing the
 * user's files. For `credentials` the default is `host` and a typo therefore
 * falls back to sharing — deliberately, because the failure it avoids (#683: an
 * instance that boots clean and fails every turn) is the worse one, and reading a
 * login risks no file of the user's. See `claude-credentials.ts`.
 *
 * `hooks` is the one where falling back on a typo is load-bearing in the other
 * direction: `PADDOCK_CLAUDE_HOOKS=hots` isolates rather than executing the
 * host's shell commands, which is the only acceptable way for a security lever
 * to misread its input. `mcpServers` follows the same direction for a weaker
 * reason — an MCP server is a process paddock spawns, so a typo that attaches
 * nothing is better than one that attaches the user's whole set unasked.
 */
function loadClaudeConfig(file: PaddockConfigFile["claude"] = {}, p: Posture): ClaudeConfig {
  const transcripts = (
    envOpt("PADDOCK_CLAUDE_TRANSCRIPTS") ?? fileOpt(file.transcripts)
  )?.toLowerCase();
  const credentials = (
    envOpt("PADDOCK_CLAUDE_CREDENTIALS") ?? fileOpt(file.credentials)
  )?.toLowerCase();
  const instructions = (
    envOpt("PADDOCK_CLAUDE_INSTRUCTIONS") ?? fileOpt(file.instructions)
  )?.toLowerCase();
  const hooks = (envOpt("PADDOCK_CLAUDE_HOOKS") ?? fileOpt(file.hooks))?.toLowerCase();
  const mcpServers = (
    envOpt("PADDOCK_CLAUDE_MCP_SERVERS") ?? fileOpt(file.mcpServers)
  )?.toLowerCase();
  return {
    transcripts:
      transcripts && isKnownTranscriptsMode(transcripts) ? transcripts : p.transcripts,
    credentials:
      credentials && isKnownCredentialsMode(credentials) ? credentials : p.credentials,
    instructions:
      instructions && isKnownInstructionsMode(instructions) ? instructions : p.instructions,
    hooks: hooks && isKnownHooksMode(hooks) ? hooks : p.hooks,
    mcpServers:
      mcpServers && isKnownMcpServersMode(mcpServers) ? mcpServers : p.mcpServers,
  };
}

/**
 * Resolve where paddock's OWN Claude home lives.
 *
 * Precedence, highest first:
 *
 * 1. **`CLAUDE_CONFIG_DIR`** — the variable *Claude Code itself* resolves its
 *    home from. Honouring it is load-bearing, not a courtesy: herdctl
 *    deliberately refuses to clobber an operator-set `CLAUDE_CONFIG_DIR`
 *    (herdctl#423), so if paddock picked a different home the SDK would write
 *    transcripts to one tree while herdctl read from another — the exact
 *    split-brain #588 fixed. Deferring to it makes that state unreachable.
 * 2. A `claudeHome:` key in the instance config file.
 * 3. **`<dataDir>/claude-home`** — the default.
 *
 * ## Paddock always OWNS this home, and the one value it refuses
 *
 * `CLAUDE_HOME` used to sit above all of this, and setting it to `~/.claude` was
 * the documented escape hatch back to the pre-#620 layout. It is gone (#691),
 * because pointing the home at the user's own directory is what welded five
 * unrelated concerns to one lever: it decided whose transcripts were at risk,
 * which keychain entry was visible, where agent memory landed, and whether
 * delete meant delete. Those are now separate keys (`claude:`), so the home no
 * longer needs to move for any of them.
 *
 * Which leaves exactly one value that must not be allowed through, from any
 * source: the user's own `~/.claude`. It re-welds the lever, and it re-breaks
 * agent memory (#690) — the memory dir is `<claudeHome>/projects/<enc>/memory`,
 * and the agent harness refuses to write to any path with a `.claude` component.
 * So it REFUSES TO START rather than silently degrading, which is the same
 * fail-closed shape as the bind-safety guard. `CLAUDE_CONFIG_DIR` cannot simply
 * be ignored instead: it is Claude Code's own variable, and disagreeing with an
 * operator-set value is the herdctl#423 split-brain again.
 *
 * NOT canonical()-ed: this exact string is what herdctl hands Claude Code as
 * `CLAUDE_CONFIG_DIR`, and canonicalising would silently diverge from the
 * literal path the two of them encode into `<home>/projects/<encoded-cwd>`.
 * The refusal check DOES resolve both sides, so a symlinked or trailing-slash
 * spelling of `~/.claude` cannot slip past it.
 *
 * This is the RESOLVER, not the accessor. It is read once by
 * {@link loadPaddockConfig} into {@link PaddockConfig.claudeHome}; runtime code
 * should thread `cfg.claudeHome` rather than call this again, so paddock and the
 * engine can never end up resolving two different homes (#588).
 */
export function resolveClaudeHome(dataDir: string, fromFile?: string): string {
  const env = envOpt("CLAUDE_CONFIG_DIR");
  const home =
    env !== undefined
      ? abs(env)
      : fromFile !== undefined && fromFile !== ""
        ? abs(fromFile)
        : path.join(dataDir, DEFAULT_CLAUDE_HOME_DIRNAME);
  const refusal = claudeHomeRefusal(home, userClaudeHome(), env !== undefined);
  if (refusal !== undefined) throw new Error(refusal);
  return home;
}

/**
 * Why `home` is unusable as paddock's own Claude home, or `undefined` if it is
 * fine. Pure, so the whole decision is testable without touching `$HOME`.
 *
 * `fromEnv` only changes which fix is named first — the refusal itself is the
 * same whichever layer supplied the value.
 */
export function claudeHomeRefusal(
  home: string,
  userHome: string,
  fromEnv: boolean,
): string | undefined {
  if (path.resolve(home) !== path.resolve(userHome)) return undefined;
  return (
    `refusing to start: the Claude home resolves to your own ${userHome}, which paddock ` +
    `must not run as its own home. It re-couples everything paddock keeps separate — ` +
    `whose transcripts a delete removes, which login is visible, where agent memory is ` +
    `written (agents cannot write under a \`.claude\` path at all, #690). ` +
    (fromEnv
      ? `CLAUDE_CONFIG_DIR is what points it there: unset it, or point it at a directory ` +
        `of paddock's own. `
      : `The \`claudeHome:\` key in paddock.config.yaml points it there: remove it, or name a ` +
        `directory of paddock's own. `) +
    `To SHARE your Claude Code transcripts, set \`claude: { transcripts: host }\` (or ` +
    `PADDOCK_CLAUDE_TRANSCRIPTS=host) — that shares the files themselves and keeps ` +
    `paddock's home where it belongs.`
  );
}

/** Directory name of paddock's own Claude home inside the data dir (#620). */
export const DEFAULT_CLAUDE_HOME_DIRNAME = "claude-home";
