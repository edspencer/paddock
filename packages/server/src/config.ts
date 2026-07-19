/**
 * Paddock server configuration, sourced from an optional YAML instance-config
 * file with environment overrides on top (precedence: file < env), and sane
 * defaults beneath both.
 *
 * Everything is resolved once at startup so the rest of the app can import a
 * frozen object. Paths are normalised to absolute.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import YAML from "yaml";
import { type DriveMode, KEEPER_DEFAULT_DRIVE_MODE, isKnownDriveMode } from "./models.js";
import { DEFAULT_MAX_SPAWN_DEPTH, isValidMaxSpawnDepth } from "./spawn-capability.js";
import { type RecoveryConfig, DEFAULT_RECOVERY } from "./recovery-config.js";

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
 * Dev/preview-server capability. When enabled, keeper agents are told (in their
 * system prompt) that they may run long-running dev servers via the on-box `pm`
 * CLI (a PM2 + shared-ports-registry wrapper). Driven entirely by env so it is
 * scoped PER INSTANCE — only the instance whose env sets
 * `PADDOCK_DEV_SERVERS_ENABLED` advertises the capability (e.g. the projects
 * instance), leaving house/homelab prompts untouched.
 */
export interface DevServersConfig {
  /** Whether keeper agents may run dev servers via `pm` (default false). */
  enabled: boolean;
  /** Host shown in dev-server URLs; must match the `pm` wrapper's PM_PUBLIC_HOST. */
  domain: string;
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

export interface PaddockConfig {
  /** HTTP/WS port. */
  port: number;
  /** Bind host. */
  host: string;
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
  /** Working directory for one-off / scratch chats. */
  scratchDir: string;
  /** Provider-agnostic user-authentication config (see AUTH.md). */
  auth: AuthConfig;
  /** Dev/preview-server capability advertised to keeper agents (per-instance). */
  devServers: DevServersConfig;
  /** Voice-dictation (Whisper) capability (per-instance; default off). */
  transcription: TranscriptionConfig;
  /** Per-instance branding (title/logo/accent; defaults preserve today's look). */
  brand: BrandConfig;
  /**
   * Global default for how keeper chat turns are driven (Paddock#111), used when
   * a project doesn't override `driveMode`. `batch` (legacy one-shot trigger) by
   * default; set `PADDOCK_KEEPER_DRIVE_MODE=session` to make cross-turn autonomy
   * (ScheduleWakeup / `/loop`) the box-wide default.
   */
  keeperDriveMode: DriveMode;
  /**
   * Whether keeper AND scratch agents use the native Claude Code system prompt +
   * project CLAUDE.md hierarchy (true, the default) instead of a terse Paddock
   * "replace" system prompt (false). Driven by `PADDOCK_KEEPER_NATIVE_PROMPT`.
   *
   * This is DELIBERATELY decoupled from {@link DevServersConfig.enabled} (issue
   * #176): the dev-servers flag advertises a `pm` capability and has nothing to
   * do with which system prompt an agent gets. When native (the default on every
   * instance), an instance-wide `CLAUDE.md` (a common ancestor of `projects/` and
   * the scratch dir) plus a per-project `CLAUDE.md` are auto-loaded — the two-
   * level native-context model. Set `PADDOCK_KEEPER_NATIVE_PROMPT=false` to fall
   * back to the terse replace prompt (e.g. an instance with no CLAUDE.md files).
   */
  nativeSystemPrompt: boolean;
  /**
   * Whether keeper turns are handed the read-only self-management MCP server
   * (issue #214 Phase 1) — the `mcp__paddock_manage__*` tools that let a keeper
   * enumerate projects/chats and read another chat's transcript. Driven by
   * `PADDOCK_SELF_MCP`; default OFF (opt-in per instance). Never injected on
   * scratch turns. The write tools (create/fork/message) are gated separately by
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
   * so the runtime add/remove APIs (`setAgentSchedule`/`removeAgentSchedule`, the
   * seam the D4 schedules UI calls) are permitted; OFF (default) makes them throw.
   * Declaring schedules statically in `project.yaml` is unaffected either way.
   * Driven by `PADDOCK_SCHEDULE_MUTATION`; accepts 1/true/yes.
   */
  scheduleMutationEnabled: boolean;
  /**
   * Instance default for the hook-management MCP (Epic G / G5, GG-4) — the
   * `mcp__paddock_manage__{list,set,remove}_hook` tools that let a project agent
   * declare/edit/delete its own event hooks. A sibling of {@link selfMcpWriteEnabled}:
   * OFF by default (opt-in), and only surfaces when the self-MCP write tools are also
   * present (the hook tools live on the same injected server, appended in the write
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
   * Log level for the server's structured logger (Fastify/pino). Driven by
   * `LOG_LEVEL`; default `info`.
   */
  logLevel: string;
  /**
   * Whether keeper + scratch agents receive the Playwright browser MCP server
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
  port?: number | string;
  host?: string;
  dataDir?: string;
  projectsRoot?: string;
  stateDir?: string;
  herdctlConfigPath?: string;
  webDist?: string;
  scratchDir?: string;
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
  devServers?: { enabled?: boolean | string; domain?: string };
  transcription?: {
    mode?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
    language?: string;
    maxUploadBytes?: number | string;
  };
  brand?: { name?: string; logo?: string; accent?: string };
  keeperDriveMode?: string;
  nativeSystemPrompt?: boolean | string;
  selfMcpEnabled?: boolean | string;
  selfMcpWriteEnabled?: boolean | string;
  maxSpawnDepth?: number | string;
  scheduleMutationEnabled?: boolean | string;
  hooksMcpEnabled?: boolean | string;
  /**
   * Keeper-chat recovery config (issue #301). Every field optional; a matching
   * `PADDOCK_RECOVERY_*` env var still overrides it (precedence file < env).
   */
  recovery?: {
    surfaceKilledTask?: boolean | string;
    autoReDrive?: boolean | string;
    debounceMs?: number | string;
    maxRetries?: number | string;
    limboTimeoutMs?: number | string;
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
 *              endpoint (e.g. `http://192.168.1.200:8385/v1`). The same kind of
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
   * remote: OpenAI-compatible base URL, e.g. `http://192.168.1.200:8385/v1`.
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
 * Resolve the dev/preview-server capability from env. Defaults to disabled, so a
 * plain instance never advertises `pm`; the projects instance opts in by setting
 * `PADDOCK_DEV_SERVERS_ENABLED=true` in its own env file. Accepts 1/true/yes.
 */
function loadDevServersConfig(file: PaddockConfigFile["devServers"] = {}): DevServersConfig {
  const raw = envOr("PADDOCK_DEV_SERVERS_ENABLED", fileOr(file.enabled, "false")).toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "yes";
  return {
    enabled,
    domain: envOr("PADDOCK_DEV_SERVERS_DOMAIN", fileOr(file.domain, "projects.valfenda.net")),
  };
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
  // working_directory of keeper/scratch agents MUST be canonical so session
  // discovery (which encodes the real path) can find Claude transcripts.
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
  const scratchDir = canonical(
    envOr("PADDOCK_SCRATCH_DIR", fileOr(file.scratchDir, path.join(dataRoot, "scratch"))),
  );

  // packages/server/src/config.ts -> packages/web/dist
  const defaultWebDist = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../web/dist",
  );

  return Object.freeze({
    port: Number(envOr("PORT", fileOr(file.port, "4000"))),
    host: envOr("HOST", fileOr(file.host, "0.0.0.0")),
    dataDir,
    projectsRoot,
    stateDir,
    herdctlConfigPath,
    webDist: abs(envOr("PADDOCK_WEB_DIST", fileOr(file.webDist, defaultWebDist))),
    scratchDir,
    auth: loadAuthConfig(file.auth),
    devServers: loadDevServersConfig(file.devServers),
    transcription: loadTranscriptionConfig(file.transcription),
    brand: loadBrandConfig(file.brand),
    keeperDriveMode: loadKeeperDriveMode(file.keeperDriveMode),
    nativeSystemPrompt: loadNativeSystemPrompt(file.nativeSystemPrompt),
    selfMcpEnabled: loadSelfMcpEnabled(file.selfMcpEnabled),
    selfMcpWriteEnabled:
      loadSelfMcpEnabled(file.selfMcpEnabled) && loadSelfMcpWriteEnabled(file.selfMcpWriteEnabled),
    maxSpawnDepth: loadMaxSpawnDepth(file.maxSpawnDepth),
    scheduleMutationEnabled: loadScheduleMutationEnabled(file.scheduleMutationEnabled),
    hooksMcpEnabled: loadHooksMcpEnabled(file.hooksMcpEnabled),
    recovery: loadRecoveryConfig(file.recovery),
    logLevel: envOr("LOG_LEVEL", fileOr(file.logLevel, "info")),
    browserMcp: loadBrowserMcp(file.browserMcp),
    sweepMinIntervalMs: loadSweepMinIntervalMs(file.sweepMinIntervalMs),
    gitAuthor: {
      name: envOr("PADDOCK_GIT_AUTHOR_NAME", fileOr(file.gitAuthor?.name, "Paddock")),
      email: envOr("PADDOCK_GIT_AUTHOR_EMAIL", fileOr(file.gitAuthor?.email, "paddock@localhost")),
    },
    githubClientId: envOpt("PADDOCK_GITHUB_CLIENT_ID") ?? fileOpt(file.githubClientId),
  });
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
 * Resolve whether keeper + scratch agents receive the Playwright browser MCP
 * (issue #269 fold). The env var keeps its exact literal-'1' semantics (any
 * other set value — including `true` — disables it, matching pre-loader
 * behaviour); only when the env var is UNSET does the config file provide the
 * base, using the 1/true/yes convention shared by the other boolean knobs.
 */
function loadBrowserMcp(file?: PaddockConfigFile["browserMcp"]): boolean {
  const env = process.env.PADDOCK_BROWSER_MCP;
  if (env !== undefined) return env === "1";
  const raw = fileOpt(file)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the instance-default max spawn depth from `PADDOCK_MAX_SPAWN_DEPTH`
 * (issue #262). Defaults to {@link DEFAULT_MAX_SPAWN_DEPTH} (`1`); a
 * missing/blank/out-of-range value falls back to the default rather than failing
 * startup. A per-project override still wins at dispatch.
 */
function loadMaxSpawnDepth(file?: PaddockConfigFile["maxSpawnDepth"]): number {
  const raw = envOpt("PADDOCK_MAX_SPAWN_DEPTH") ?? fileOpt(file);
  if (raw === undefined) return DEFAULT_MAX_SPAWN_DEPTH;
  const n = Number(raw);
  return isValidMaxSpawnDepth(n) ? n : DEFAULT_MAX_SPAWN_DEPTH;
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
    limboTimeoutMs: loadRecoveryInt(
      "PADDOCK_RECOVERY_LIMBO_MS",
      f.limboTimeoutMs,
      DEFAULT_RECOVERY.limboTimeoutMs,
    ),
  };
}

/**
 * Resolve the per-deployment schedule-mutation gate (issue #265 / DD-7). Defaults
 * OFF so a plain instance can't have its schedules mutated programmatically; an
 * operator opts in with `PADDOCK_SCHEDULE_MUTATION=1` (or the config file). Accepts
 * 1/true/yes. Static `project.yaml` schedules are armed regardless of this flag.
 */
function loadScheduleMutationEnabled(
  file?: PaddockConfigFile["scheduleMutationEnabled"],
): boolean {
  const raw = envOr("PADDOCK_SCHEDULE_MUTATION", fileOr(file, "false")).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the instance-default hook-management MCP gate (Epic G / G5, GG-4).
 * Defaults OFF so a plain instance never advertises the hook tools; opt in with
 * `PADDOCK_HOOKS_MCP=1` (or the config file), and a per-project `hooksMcpEnabled`
 * override still wins at dispatch. Accepts 1/true/yes. Only meaningful when the
 * self-MCP write tools are also enabled (the hook tools live on that server).
 */
function loadHooksMcpEnabled(file?: PaddockConfigFile["hooksMcpEnabled"]): boolean {
  const raw = envOr("PADDOCK_HOOKS_MCP", fileOr(file, "false")).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keepers additionally get the self-management MCP WRITE tools
 * (issue #214 Phase 2). Defaults OFF; only takes effect when `PADDOCK_SELF_MCP`
 * is also on (write implies read — enforced at the call site above). Accepts
 * 1/true/yes.
 */
function loadSelfMcpWriteEnabled(file?: PaddockConfigFile["selfMcpWriteEnabled"]): boolean {
  const raw = envOr("PADDOCK_SELF_MCP_WRITE", fileOr(file, "false")).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keepers get the read-only self-management MCP (issue #214).
 * Defaults to OFF so a plain instance never advertises it; opt in per instance
 * with `PADDOCK_SELF_MCP=1`. Accepts 1/true/yes.
 */
function loadSelfMcpEnabled(file?: PaddockConfigFile["selfMcpEnabled"]): boolean {
  const raw = envOr("PADDOCK_SELF_MCP", fileOr(file, "false")).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve whether keeper/scratch agents use the native system prompt + CLAUDE.md
 * hierarchy (issue #176). Defaults to `true` (native) on every instance so a
 * seeded instance-wide + per-project `CLAUDE.md` is auto-loaded; set
 * `PADDOCK_KEEPER_NATIVE_PROMPT` to 0/false/no to fall back to the terse replace
 * prompt. Intentionally independent of `PADDOCK_DEV_SERVERS_ENABLED`.
 */
function loadNativeSystemPrompt(file?: PaddockConfigFile["nativeSystemPrompt"]): boolean {
  const raw = envOr("PADDOCK_KEEPER_NATIVE_PROMPT", fileOr(file, "true")).toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}

/**
 * Resolve the global keeper drive mode from `PADDOCK_KEEPER_DRIVE_MODE`. Defaults
 * to `batch` (KEEPER_DEFAULT_DRIVE_MODE); an unrecognized value falls back to the
 * default rather than failing startup. A per-project `driveMode` still overrides
 * this at dispatch.
 */
function loadKeeperDriveMode(file?: PaddockConfigFile["keeperDriveMode"]): DriveMode {
  const raw = (envOpt("PADDOCK_KEEPER_DRIVE_MODE") ?? fileOpt(file))?.toLowerCase();
  return raw && isKnownDriveMode(raw) ? raw : KEEPER_DEFAULT_DRIVE_MODE;
}

/** Default Claude home, used for session discovery. */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
}
