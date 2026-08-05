/**
 * Instance-wide settings surface (issue #385).
 *
 * Paddock's instance config (`PaddockConfig`) is resolved ONCE at boot and
 * `Object.freeze`d — env over an optional `paddock.config.yaml` file over
 * built-in defaults (see config.ts). Until now the only way to change a knob was
 * to hand-edit that YAML (or an env var) and restart. This module backs a
 * top-level admin Settings screen that reads the resolved config and writes the
 * editable subset back to `paddock.config.yaml`.
 *
 * Three properties the screen depends on, enforced here:
 *
 *  1. **Restart-required.** Writes go to the file only; the running process keeps
 *     its frozen config. Every field is `restart` in effect — the UI shows a
 *     persistent "takes effect after restart" banner.
 *  2. **Env precedence.** `env > file > default`. A field also set by a
 *     `PADDOCK_*` env var is SHADOWED — writing it to the file has no effect
 *     while the env var is set. {@link buildInstanceConfig} reports `envOverridden`
 *     per field so the UI renders those read-only.
 *  3. **Comment-preserving write.** {@link writeInstanceConfig} round-trips the
 *     file through the `yaml` `Document` API (not parse+stringify), so operator
 *     comments and any keys we don't manage survive. The write is atomic
 *     (temp + rename), and the file is created on first write if absent.
 *
 * Only the fields in {@link FIELDS} are exposed, and only those marked `editable`
 * may be written — path/infra bindings (port, dataDir, …) and auth are read-only
 * display. Secret values (a transcription API key, auth JWT internals) are never
 * put in the descriptor table, so they can't leak into the API response.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { DRIVE_MODES, DEFAULT_DRIVE_MODE, MODELS, isKnownModel } from "./models.js";
import { DEFAULT_MAX_SPAWN_DEPTH, isValidMaxSpawnDepth } from "./spawn-capability.js";
import { DEFAULT_RECOVERY } from "./recovery-config.js";
import { DEFAULT_ATTACHMENTS, sanitizeAllowedTypes } from "./attachments-config.js";
import { DEFAULT_CURATION } from "./curation-config.js";
import { DEFAULT_ENVIRONMENT_PROMPT } from "./environment-prompt.js";
import { DEFAULT_TRANSCRIPTS_MODE } from "./transcripts.js";
import { type PaddockConfig } from "./config.js";

/** Groups the Settings screen renders, in display order. */
export const GROUPS: { id: string; label: string; description?: string }[] = [
  { id: "curation", label: "Curation", description: "Per-file token budgets the post-turn sweeper keeps its curated files under." },
  { id: "sweeper", label: "Sweeper" },
  { id: "capabilities", label: "Capabilities", description: "What keeper agents are allowed to do. Most default off." },
  { id: "recovery", label: "Recovery" },
  { id: "attachments", label: "Attachments" },
  { id: "branding", label: "Branding" },
  { id: "transcription", label: "Transcription" },
  { id: "git", label: "Git identity" },
  { id: "logging", label: "Logging" },
  { id: "advanced", label: "Advanced (read-only)", description: "Process / filesystem bindings. Change these via env/redeploy, not the UI." },
];

/**
 * How the Settings screen renders a field. `text` is `string` with a multi-line
 * control (a `<textarea>`) — same wire shape, same coercion contract; the only
 * difference is that the UI stops squashing paragraphs into one line.
 */
type FieldType = "number" | "boolean" | "string" | "text" | "enum" | "string-list";

/** Outcome of coercing a raw patch value into a persistable one. */
type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * One editable-or-displayed instance-config field. `key` is a stable dotted path
 * used both to read the resolved value out of {@link PaddockConfig} and as the
 * write path into the YAML document — the two shapes match by construction.
 */
interface FieldSpec {
  /** Stable dotted id (also the YAML/`PaddockConfig` path). */
  key: string;
  group: string;
  label: string;
  help?: string;
  type: FieldType;
  /** Allowed values for `enum` fields. */
  enumValues?: readonly string[];
  /** Env var(s) that shadow this field; the first set one is reported. */
  envVars: readonly string[];
  /**
   * Env-shadow semantics. Default (`false`) = the var shadows only when set to a
   * non-blank value, matching `envOr`/`envOpt` in config.ts. Set `true` for the
   * fields whose loaders key on `env !== undefined` instead, so a defined-but-
   * blank var is still authoritative and must render read-only here too:
   *  - `browserMcp` (`loadBrowserMcp`) — a blank `PADDOCK_BROWSER_MCP` forces
   *    `false`;
   *  - `environmentPrompt` (`loadEnvironmentPrompt`, #635) — a blank
   *    `PADDOCK_ENVIRONMENT_PROMPT` IS the opt-out.
   */
  envShadowWhenDefined?: boolean;
  /** Built-in default (what you get with neither env nor file). `null` ⇒ unset. */
  default: unknown;
  /** Whether the UI may edit + PUT this field. Read-only fields are display-only. */
  editable: boolean;
  /** Semi-sensitive (shown with a caution note); never carries a secret value. */
  sensitive?: boolean;
  /**
   * Validate + coerce a raw JSON patch value into the value written to YAML.
   * Only defined for editable fields. Mirrors the loader's acceptance so a UI
   * write can't produce a file the loader would reject (it would just degrade).
   */
  coerce?: (raw: unknown) => Coerced;
}

// --- coercion helpers -------------------------------------------------------

const asBool = (raw: unknown): Coerced =>
  typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: "must be a boolean" };

const posInt = (raw: unknown): Coerced => {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
    ? { ok: true, value: n }
    : { ok: false, error: "must be a positive integer" };
};

const nonNegInt = (raw: unknown): Coerced => {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0
    ? { ok: true, value: n }
    : { ok: false, error: "must be a non-negative integer" };
};

/** A non-negative number, OR null/empty-string to clear the override. */
const optNonNegNumber = (raw: unknown): Coerced => {
  if (raw === null || raw === "" || raw === undefined) return { ok: true, value: null };
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? { ok: true, value: n }
    : { ok: false, error: "must be a non-negative number (or blank to use the default)" };
};

const nonEmptyString = (raw: unknown): Coerced =>
  typeof raw === "string" && raw.trim().length > 0
    ? { ok: true, value: raw.trim() }
    : { ok: false, error: "must be a non-empty string" };

/** A string that may be blank (blank clears the override → falls back to default). */
const optString = (raw: unknown): Coerced =>
  typeof raw === "string" ? { ok: true, value: raw.trim() } : { ok: false, error: "must be a string" };

/**
 * Upper bound on a prompt-shaped field, in characters. Nothing enforces a limit
 * downstream — the text is concatenated into the system prompt of every single
 * turn — so an accidental paste of a whole file would quietly tax every request
 * on the instance forever. 32 KiB is ~50× the built-in default and far more than
 * any deliberate environment note; past that, a 400 is kinder than silence.
 */
const MAX_PROMPT_CHARS = 32 * 1024;

/**
 * A free-text prompt body. Unlike {@link optString} this is **verbatim**: no
 * trimming, because leading/trailing whitespace is content in a prompt and the
 * operator's text must round-trip through YAML byte-for-byte.
 *
 * The three authoring states map onto the wire like this:
 *  - `null` → delete the key → fall back to Paddock's built-in default,
 *  - `""` → written as an empty string → append nothing (opt out),
 *  - any other string → written verbatim → appended instead of the default.
 *
 * Rejects a NUL byte: it survives neither the repo's no-NUL invariant
 * (`scripts/check-no-nul-bytes.mjs`) nor any useful reading of "a prompt".
 */
const promptText = (raw: unknown): Coerced => {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "must be a string (or null to restore the default)" };
  if (raw.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: `must be at most ${MAX_PROMPT_CHARS} characters (got ${raw.length})` };
  }
  if (raw.includes("\0")) return { ok: false, error: "must not contain NUL bytes" };
  return { ok: true, value: raw };
};

const oneOf =
  (values: readonly string[]) =>
  (raw: unknown): Coerced =>
    typeof raw === "string" && values.includes(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `must be one of: ${values.join(", ")}` };

const spawnDepth = (raw: unknown): Coerced => {
  const n = Number(raw);
  return isValidMaxSpawnDepth(n)
    ? { ok: true, value: n }
    : { ok: false, error: "must be a small non-negative integer" };
};

const hexColor = (raw: unknown): Coerced =>
  typeof raw === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.trim())
    ? { ok: true, value: raw.trim() }
    : { ok: false, error: "must be a hex color like #c2603c" };

const stringList = (raw: unknown): Coerced => {
  const list = sanitizeAllowedTypes(raw);
  return list ? { ok: true, value: list } : { ok: false, error: "must be a non-empty list of type/extension strings" };
};

/**
 * Coerce a raw model allow-list (issue #457 Step 2) into a de-duped list of
 * KNOWN catalog ids. Accepts a real array or a comma-separated string. Rejects
 * (400) an unknown id — operators pick from the built-in catalog by id, so a typo
 * surfaces rather than silently offering nothing — and rejects an empty result
 * (write at least one, or clear the whole field to fall back to the full catalog).
 */
const modelList = (raw: unknown): Coerced => {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!arr) return { ok: false, error: "must be a list of model ids" };
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (!isKnownModel(id)) return { ok: false, error: `unknown model id: ${id}` };
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0
    ? { ok: true, value: ids }
    : { ok: false, error: "must include at least one known model id" };
};

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

// --- field catalog ----------------------------------------------------------

/**
 * The single source of truth for the instance-settings surface. Order within a
 * group is display order. Editable fields carry a `coerce`; read-only fields
 * don't. NO field here holds a secret value (that's why auth JWT internals and
 * the transcription API key are absent).
 */
export const FIELDS: readonly FieldSpec[] = [
  // Curation — the motivating knobs (issue #379).
  { key: "curation.overviewMaxTokens", group: "curation", label: "OVERVIEW.md max tokens", type: "number", envVars: ["PADDOCK_CURATION_OVERVIEW_MAX_TOKENS"], default: DEFAULT_CURATION.overviewMaxTokens, editable: true, coerce: posInt },
  { key: "curation.changelogMaxTokens", group: "curation", label: "CHANGELOG.md max tokens", type: "number", envVars: ["PADDOCK_CURATION_CHANGELOG_MAX_TOKENS"], default: DEFAULT_CURATION.changelogMaxTokens, editable: true, coerce: posInt },
  { key: "curation.claudeMaxTokens", group: "curation", label: "CLAUDE.md max tokens", type: "number", envVars: ["PADDOCK_CURATION_CLAUDEMD_MAX_TOKENS"], default: DEFAULT_CURATION.claudeMaxTokens, editable: true, coerce: posInt },

  // Sweeper.
  { key: "sweepMinIntervalMs", group: "sweeper", label: "Min sweep interval (ms)", help: "Minimum ms between post-turn sweeps for one project. Blank = default (5 min).", type: "number", envVars: ["PADDOCK_SWEEP_MIN_INTERVAL_MS"], default: null, editable: true, coerce: optNonNegNumber },

  // Capabilities.
  { key: "driveMode", group: "capabilities", label: "Keeper drive mode", help: "session = persistent (streaming + cross-turn autonomy); batch = legacy one-shot.", type: "enum", enumValues: DRIVE_MODES, envVars: ["PADDOCK_DRIVE_MODE"], default: DEFAULT_DRIVE_MODE, editable: true, coerce: oneOf(DRIVE_MODES) },
  { key: "models", group: "capabilities", label: "Offered models", help: "Which built-in catalog models the picker offers, by id (e.g. claude-opus-5, claude-sonnet-5). Blank = offer all catalog models.", type: "string-list", envVars: ["PADDOCK_MODELS"], default: MODELS.map((m) => m.id), editable: true, coerce: modelList },
  { key: "nativeSystemPrompt", group: "capabilities", label: "Native system prompt", help: "Use Claude Code's native prompt + CLAUDE.md hierarchy (recommended).", type: "boolean", envVars: ["PADDOCK_NATIVE_PROMPT"], default: true, editable: true, coerce: asBool },
  // Issue #635. `envShadowWhenDefined` because loadEnvironmentPrompt keys on
  // definedness, not emptiness — a defined-but-empty PADDOCK_ENVIRONMENT_PROMPT
  // IS the env-level opt-out, so it genuinely shadows the file and must render
  // read-only. `default` carries the built-in text so the UI can offer a
  // one-click restore (a `null` PUT deletes the key) without duplicating it.
  { key: "environmentPrompt", group: "capabilities", label: "Environment prompt", help: "Appended to every keeper turn's system prompt: what the agent should know about rendering into Paddock rather than a terminal. Clear it to append nothing.", type: "text", envVars: ["PADDOCK_ENVIRONMENT_PROMPT"], envShadowWhenDefined: true, default: DEFAULT_ENVIRONMENT_PROMPT, editable: true, coerce: promptText },
  { key: "selfMcpEnabled", group: "capabilities", label: "Self-management MCP (read)", help: "Let keepers list/read projects and other chats.", type: "boolean", envVars: ["PADDOCK_SELF_MCP"], default: false, editable: true, coerce: asBool },
  { key: "selfMcpWriteEnabled", group: "capabilities", label: "Self-management MCP (write)", help: "Let keepers create/fork/message chats (needs read enabled too).", type: "boolean", envVars: ["PADDOCK_SELF_MCP_WRITE"], default: false, editable: true, coerce: asBool },
  { key: "selfMcpProjectsEnabled", group: "capabilities", label: "Self-management MCP (projects)", help: "Let keepers create whole new projects, cloning a repo when repo-backed (needs self-MCP write).", type: "boolean", envVars: ["PADDOCK_SELF_MCP_PROJECTS"], default: false, editable: true, coerce: asBool },
  { key: "maxSpawnDepth", group: "capabilities", label: "Max spawn depth", help: "How deep a spawn tree may grow before children lose the self-MCP.", type: "number", envVars: ["PADDOCK_MAX_SPAWN_DEPTH"], default: DEFAULT_MAX_SPAWN_DEPTH, editable: true, coerce: spawnDepth },
  { key: "scheduleMutationEnabled", group: "capabilities", label: "Schedule mutation", help: "Allow programmatic schedule add/remove at runtime.", type: "boolean", envVars: ["PADDOCK_SCHEDULE_MUTATION"], default: false, editable: true, coerce: asBool },
  { key: "hooksMcpEnabled", group: "capabilities", label: "Hooks MCP", help: "Let agents declare/edit their own event hooks (needs self-MCP write).", type: "boolean", envVars: ["PADDOCK_HOOKS_MCP"], default: false, editable: true, coerce: asBool },
  { key: "browserMcp", group: "capabilities", label: "Browser MCP (Playwright)", help: "Give agents a headless Chromium browser MCP.", type: "boolean", envVars: ["PADDOCK_BROWSER_MCP"], envShadowWhenDefined: true, default: false, editable: true, coerce: asBool },

  // Recovery (issue #301).
  { key: "recovery.surfaceKilledTask", group: "recovery", label: "Surface killed task", type: "boolean", envVars: ["PADDOCK_RECOVERY_SURFACE"], default: DEFAULT_RECOVERY.surfaceKilledTask, editable: true, coerce: asBool },
  { key: "recovery.autoReDrive", group: "recovery", label: "Auto re-drive", type: "boolean", envVars: ["PADDOCK_RECOVERY_AUTODRIVE"], default: DEFAULT_RECOVERY.autoReDrive, editable: true, coerce: asBool },
  { key: "recovery.debounceMs", group: "recovery", label: "Debounce (ms)", type: "number", envVars: ["PADDOCK_RECOVERY_DEBOUNCE_MS"], default: DEFAULT_RECOVERY.debounceMs, editable: true, coerce: nonNegInt },
  { key: "recovery.maxRetries", group: "recovery", label: "Max retries", type: "number", envVars: ["PADDOCK_RECOVERY_MAX_RETRIES"], default: DEFAULT_RECOVERY.maxRetries, editable: true, coerce: nonNegInt },
  { key: "recovery.limboTimeoutMs", group: "recovery", label: "Limbo timeout (ms)", type: "number", envVars: ["PADDOCK_RECOVERY_LIMBO_MS"], default: DEFAULT_RECOVERY.limboTimeoutMs, editable: true, coerce: nonNegInt },

  // Attachments (issue #328).
  { key: "attachments.enabled", group: "attachments", label: "Enabled", type: "boolean", envVars: ["PADDOCK_ATTACHMENTS_ENABLED"], default: DEFAULT_ATTACHMENTS.enabled, editable: true, coerce: asBool },
  { key: "attachments.maxFileSizeMb", group: "attachments", label: "Max file size (MB)", type: "number", envVars: ["PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB"], default: DEFAULT_ATTACHMENTS.maxFileSizeMb, editable: true, coerce: posInt },
  { key: "attachments.maxFilesPerMessage", group: "attachments", label: "Max files / message", type: "number", envVars: ["PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE"], default: DEFAULT_ATTACHMENTS.maxFilesPerMessage, editable: true, coerce: posInt },
  { key: "attachments.allowedTypes", group: "attachments", label: "Allowed types", help: "MIME types / extensions (e.g. image/*, .pdf). * = allow all.", type: "string-list", envVars: ["PADDOCK_ATTACHMENTS_ALLOWED_TYPES"], default: [...DEFAULT_ATTACHMENTS.allowedTypes], editable: true, coerce: stringList },

  // Branding (issue #34).
  { key: "brand.name", group: "branding", label: "Name", type: "string", envVars: ["PADDOCK_BRAND_NAME"], default: "Paddock", editable: true, coerce: nonEmptyString },
  { key: "brand.logo", group: "branding", label: "Logo", help: "An emoji/glyph, or a URL/path to an image.", type: "string", envVars: ["PADDOCK_BRAND_LOGO"], default: "🐎", editable: true, coerce: nonEmptyString },
  { key: "brand.accent", group: "branding", label: "Accent color", type: "string", envVars: ["PADDOCK_BRAND_ACCENT"], default: "#c2603c", editable: true, coerce: hexColor },

  // Transcription (voice dictation). endpoint is semi-sensitive; apiKey is a
  // secret and deliberately NOT surfaced here.
  { key: "transcription.mode", group: "transcription", label: "Mode", type: "enum", enumValues: ["off", "local", "remote"], envVars: ["PADDOCK_WHISPER_MODE"], default: "off", editable: true, coerce: oneOf(["off", "local", "remote"]) },
  { key: "transcription.model", group: "transcription", label: "Model", type: "string", envVars: ["PADDOCK_WHISPER_MODEL"], default: "base", editable: true, coerce: nonEmptyString },
  { key: "transcription.endpoint", group: "transcription", label: "Endpoint", help: "remote mode: OpenAI-compatible base URL.", type: "string", envVars: ["PADDOCK_WHISPER_ENDPOINT"], default: null, editable: true, sensitive: true, coerce: optString },

  // Git identity.
  { key: "gitAuthor.name", group: "git", label: "Author name", type: "string", envVars: ["PADDOCK_GIT_AUTHOR_NAME"], default: "Paddock", editable: true, coerce: nonEmptyString },
  { key: "gitAuthor.email", group: "git", label: "Author email", type: "string", envVars: ["PADDOCK_GIT_AUTHOR_EMAIL"], default: "paddock@localhost", editable: true, coerce: nonEmptyString },

  // Logging.
  { key: "logLevel", group: "logging", label: "Log level", type: "enum", enumValues: LOG_LEVELS, envVars: ["LOG_LEVEL"], default: "info", editable: true, coerce: oneOf(LOG_LEVELS) },

  // Advanced — read-only display (process / filesystem bindings).
  { key: "port", group: "advanced", label: "Port", type: "number", envVars: ["PORT"], default: 4000, editable: false },
  { key: "host", group: "advanced", label: "Host", type: "string", envVars: ["HOST", "PADDOCK_HOST"], default: "127.0.0.1", editable: false },
  { key: "dataDir", group: "advanced", label: "Data dir", type: "string", envVars: ["PADDOCK_DATA_DIR"], default: null, editable: false },
  { key: "projectsRoot", group: "advanced", label: "Projects root", type: "string", envVars: ["PADDOCK_PROJECTS_DIR"], default: null, editable: false },
  { key: "stateDir", group: "advanced", label: "State dir", type: "string", envVars: ["PADDOCK_STATE_DIR"], default: null, editable: false },
  { key: "herdctlConfigPath", group: "advanced", label: "herdctl config path", type: "string", envVars: ["PADDOCK_HERDCTL_CONFIG"], default: null, editable: false },
  { key: "webDist", group: "advanced", label: "Web dist", type: "string", envVars: ["PADDOCK_WEB_DIST"], default: null, editable: false },
  // What this instance shares with the host's Claude Code (#691). READ-ONLY on
  // purpose: `host` means paddock writes to the user's real transcript files,
  // and the symlinks that implement it are planted at agent-registration time —
  // a toggle that silently does nothing until the next boot would be worse than
  // no toggle. It is surfaced because "what is this instance sharing?" should be
  // answerable without reading a YAML file.
  { key: "claude.transcripts", group: "advanced", label: "Transcripts", help: "own = Paddock's own, in each project's .chats/; host = your ~/.claude transcripts, shared live.", type: "string", envVars: ["PADDOCK_CLAUDE_TRANSCRIPTS"], default: DEFAULT_TRANSCRIPTS_MODE, editable: false },
  // Auth: read-only in v1 (misconfig can lock everyone out — issue #385). Only
  // the mode is surfaced; JWT/JWKS internals stay out of the API.
  { key: "auth.mode", group: "advanced", label: "Auth mode", type: "string", envVars: ["PADDOCK_AUTH_MODE"], default: "none", editable: false, sensitive: true },
  // GitHub client id: not a secret, but semi-sensitive — read-only display.
  { key: "githubClientId", group: "advanced", label: "GitHub client id", type: "string", envVars: ["PADDOCK_GITHUB_CLIENT_ID"], default: null, editable: false, sensitive: true },
];

/** Fast lookup + editable allowlist for the PUT path. */
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** Read a dotted path out of an object, tolerating missing intermediates. */
function readPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The env var currently shadowing a field, or undefined. By default a var
 * shadows only when set to a non-blank value (matching `envOr`/`envOpt`); when
 * `whenDefined` is set, ANY defined value shadows (matching `loadBrowserMcp`'s
 * `env !== undefined` semantics — a defined-but-blank var still forces `false`).
 */
function envOverride(envVars: readonly string[], whenDefined = false): string | undefined {
  for (const name of envVars) {
    const v = process.env[name];
    if (v === undefined) continue;
    if (whenDefined || v.trim().length > 0) return name;
  }
  return undefined;
}

/** One field's DTO in the GET response. */
export interface InstanceConfigFieldDto {
  key: string;
  group: string;
  label: string;
  help?: string;
  type: FieldType;
  enumValues?: readonly string[];
  value: unknown;
  default: unknown;
  editable: boolean;
  sensitive: boolean;
  envOverridden: boolean;
  /** The env var shadowing this field (only when `envOverridden`). */
  envVar?: string;
}

export interface InstanceConfigGroupDto {
  id: string;
  label: string;
  description?: string;
  fields: InstanceConfigFieldDto[];
}

export interface InstanceConfigDto {
  groups: InstanceConfigGroupDto[];
  /** Absolute path of the file a PUT writes to (informational). */
  configPath: string;
  /** Always false — instance config is frozen at boot; edits need a restart. */
  restartRequired: false;
}

/**
 * Default filename for the instance-config file, resolved under the data dir.
 * Kept in sync with config.ts's private constant (both point at the same file);
 * duplicated here so this module needn't reach into config.ts internals.
 */
const DEFAULT_CONFIG_FILENAME = "paddock.config.yaml";

/**
 * Resolve the path a PUT writes to: an explicit `PADDOCK_CONFIG` env var wins
 * (the same rule {@link import("./config.js").loadConfigFile} reads it back
 * from), else `<dataDir>/paddock.config.yaml`.
 */
export function instanceConfigPath(cfg: PaddockConfig): string {
  const explicit = process.env.PADDOCK_CONFIG;
  if (explicit && explicit.trim().length > 0) {
    const p = explicit.trim();
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }
  return path.join(cfg.dataDir, DEFAULT_CONFIG_FILENAME);
}

/**
 * Build the grouped GET DTO from the resolved (frozen) config + live env. Each
 * field reports its current `value`, built-in `default`, and whether an env var
 * currently shadows it (so the UI renders env-shadowed fields read-only).
 */
export function buildInstanceConfig(cfg: PaddockConfig): InstanceConfigDto {
  const groups: InstanceConfigGroupDto[] = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    description: g.description,
    fields: [],
  }));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  for (const f of FIELDS) {
    const shadow = envOverride(f.envVars, f.envShadowWhenDefined);
    const raw = readPath(cfg, f.key);
    const dto: InstanceConfigFieldDto = {
      key: f.key,
      group: f.group,
      label: f.label,
      help: f.help,
      type: f.type,
      enumValues: f.enumValues,
      // `undefined` (e.g. sweepMinIntervalMs unset, optional endpoint) → null so
      // it JSON-serializes as an explicit absence rather than dropping the key.
      value: raw === undefined ? null : raw,
      default: f.default,
      editable: f.editable,
      sensitive: f.sensitive ?? false,
      envOverridden: shadow !== undefined,
      envVar: shadow,
    };
    groupById.get(f.group)?.fields.push(dto);
  }

  return { groups, configPath: instanceConfigPath(cfg), restartRequired: false };
}

/** A rejected PUT: which field failed and why (surfaced as a 400). */
export class InstanceConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "InstanceConfigError";
  }
}

/**
 * Validate a patch of editable fields and coerce each value. Throws
 * {@link InstanceConfigError} on the first offending field:
 *  - an unknown key,
 *  - a read-only / non-editable key,
 *  - a value the field's `coerce` rejects.
 * Returns the coerced `{ key, value }` pairs ready to write. A field whose value
 * is `null` (an editable optional being cleared) is returned with `value: null`
 * so the writer can delete it from the file.
 */
export function validatePatch(patch: Record<string, unknown>): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const spec = FIELD_BY_KEY.get(key);
    if (!spec) throw new InstanceConfigError(`Unknown setting: ${key}`, key);
    if (!spec.editable || !spec.coerce) {
      throw new InstanceConfigError(`Setting is read-only: ${key}`, key);
    }
    const res = spec.coerce(raw);
    if (!res.ok) throw new InstanceConfigError(`${spec.label} (${key}) ${res.error}`, key);
    out.push({ key, value: res.value });
  }
  return out;
}

/**
 * Write the validated pairs into `paddock.config.yaml`, preserving operator
 * comments and unmanaged keys. Uses the `yaml` `Document` API to round-trip an
 * existing file (or start a fresh document when none exists), then writes
 * atomically (temp + rename). A `null` value deletes that key (clearing an
 * optional back to its default). Returns the path written.
 *
 * Reuses no loader state — the caller passes the target path (from
 * {@link instanceConfigPath}) so tests can point it anywhere.
 */
export function writeInstanceConfig(
  configPath: string,
  pairs: { key: string; value: unknown }[],
): void {
  let raw = "";
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Missing file → create-on-first-write (a fresh, comment-free document).
  }

  const doc = parseDocument(raw);
  // An empty / comments-only file parses to a null document body; give it a map
  // so setIn has somewhere to place keys.
  if (doc.contents == null) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;

  for (const { key, value } of pairs) {
    const p = key.split(".");
    if (value === null) doc.deleteIn(p);
    else doc.setIn(p, value);
  }

  const serialized = doc.toString();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Atomic write: same-dir temp file + rename, so a reader never sees a
  // half-written config (rename is atomic on the same filesystem).
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, configPath);
}
