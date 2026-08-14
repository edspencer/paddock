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
import { createHash } from "node:crypto";
import { parse, parseDocument } from "yaml";
import { DRIVE_MODES, DEFAULT_DRIVE_MODE, MODELS, isKnownModel } from "./models.js";
import { DEFAULT_MAX_SPAWN_DEPTH, isValidMaxSpawnDepth } from "./spawn-capability.js";
import { DEFAULT_RECOVERY } from "./recovery-config.js";
import { DEFAULT_ATTACHMENTS, sanitizeAllowedTypes } from "./attachments-config.js";
import { DEFAULT_CURATION } from "./curation-config.js";
import { DEFAULT_ENVIRONMENT_PROMPT } from "./environment-prompt.js";
import { CONFIG_SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./schema-version.js";
import { DEFAULT_TRANSCRIPTS_MODE } from "./transcripts.js";
import { DEFAULT_CREDENTIALS_MODE } from "./claude-credentials.js";
import { DEFAULT_INSTRUCTIONS_MODE } from "./claude-instructions.js";
import { DEFAULT_HOOKS_MODE } from "./claude-settings.js";
import { DEFAULT_MCP_SERVERS_MODE } from "./claude-mcp.js";
import { type PaddockConfig } from "./config.js";

/** Groups the Settings screen renders, in display order. */
export const GROUPS: { id: string; label: string; description?: string }[] = [
  { id: "curation", label: "Curation", description: "Per-file token budgets the post-turn sweeper keeps its curated files under." },
  { id: "sweeper", label: "Sweeper" },
  { id: "capabilities", label: "Capabilities", description: "What keeper agents are allowed to do. Most default off." },
  { id: "recovery", label: "Recovery" },
  { id: "attachments", label: "Attachments" },
  { id: "branding", label: "Branding" },
  { id: "onboarding", label: "Onboarding", description: "What the root workspace's Home offers someone who has just arrived." },
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
  /**
   * This field's CONSUMER re-reads the file, so a file/running divergence does
   * not mean a restart is pending (issue #865).
   *
   * Every other field here is resolved once at boot and frozen, which is why the
   * screen's whole premise is "edits take effect after a restart". The Getting
   * Started dismissal is the exception: the web UI reads it out of this DTO's
   * `pendingValue` — the file, this instant — so a write is live the moment it
   * lands. Left unmarked it would light the restart banner every time someone
   * closed a card, telling an operator to restart a server for a change that has
   * already taken effect.
   *
   * `pendingValue` is still reported: what the file says is the truth here, and
   * it is what the UI binds to.
   */
  liveReload?: boolean;
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

/**
 * Parse a JSON patch value that is meant to be a number, WITHOUT `Number()`'s
 * coercions (issue #723). `Number()` happily turns `null` into `0`, `true` into
 * `1` and `[7]` into `7` — so `{"recovery.maxRetries": null}`, documented to
 * CLEAR the override, used to write a very meaningful `0` instead. Only a real
 * number, or a non-blank numeric string (what an `<input type=number>` sends),
 * counts; everything else is `NaN` and gets rejected by the callers below.
 */
const numeric = (raw: unknown): number => {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw.trim());
  return NaN;
};

/**
 * Ceiling for the numeric fields. Nothing downstream bounds these — a paste-o of
 * `20000000` into a millisecond timeout is a 231-day debounce, and a token budget
 * of 1e15 disables curation silently. A billion is far past any deliberate value
 * (≈31 years in ms) and keeps every one of them a safe integer.
 */
const MAX_NUMBER = 1e9;

/**
 * Ceiling for a plain `string` field, in characters. These are names, paths and
 * URLs; without a bound a 200 KB paste into `brand.name` becomes a 200 KB
 * `paddock.config.yaml` that every boot must parse. The prompt-shaped `text`
 * fields have their own, much larger {@link MAX_PROMPT_CHARS}.
 */
const MAX_STRING_CHARS = 1024;

const posInt = (raw: unknown): Coerced => {
  const n = numeric(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_NUMBER
    ? { ok: true, value: n }
    : { ok: false, error: `must be a positive integer (at most ${MAX_NUMBER})` };
};

/** A non-negative integer, OR null/empty-string to clear the override (#723). */
const nonNegInt = (raw: unknown): Coerced => {
  if (raw === null || raw === "" || raw === undefined) return { ok: true, value: null };
  const n = numeric(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_NUMBER
    ? { ok: true, value: n }
    : {
        ok: false,
        error: `must be a non-negative integer up to ${MAX_NUMBER} (or blank to use the default)`,
      };
};

/** A non-negative number, OR null/empty-string to clear the override. */
const optNonNegNumber = (raw: unknown): Coerced => {
  if (raw === null || raw === "" || raw === undefined) return { ok: true, value: null };
  const n = numeric(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_NUMBER
    ? { ok: true, value: n }
    : { ok: false, error: `must be a non-negative number up to ${MAX_NUMBER} (or blank to use the default)` };
};

const nonEmptyString = (raw: unknown): Coerced => {
  if (typeof raw !== "string") return { ok: false, error: "must be a non-empty string" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "must be a non-empty string" };
  if (trimmed.length > MAX_STRING_CHARS) {
    return { ok: false, error: `must be at most ${MAX_STRING_CHARS} characters (got ${trimmed.length})` };
  }
  return { ok: true, value: trimmed };
};

/** A string that may be blank (blank clears the override → falls back to default). */
const optString = (raw: unknown): Coerced => {
  if (typeof raw !== "string") return { ok: false, error: "must be a string" };
  const trimmed = raw.trim();
  return trimmed.length <= MAX_STRING_CHARS
    ? { ok: true, value: trimmed }
    : { ok: false, error: `must be at most ${MAX_STRING_CHARS} characters (got ${trimmed.length})` };
};

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
  // Same shape as `nonNegInt`, for the same #723 reason: `Number(null)` is 0,
  // which IS a valid depth — so "clear this override" wrote the one depth that
  // switches every child's self-MCP off. Depth 0 stays settable; it just has to
  // be asked for.
  if (raw === null || raw === "" || raw === undefined) return { ok: true, value: null };
  const n = numeric(raw);
  return isValidMaxSpawnDepth(n)
    ? { ok: true, value: n }
    : { ok: false, error: "must be a small non-negative integer (or blank to use the default)" };
};

const hexColor = (raw: unknown): Coerced =>
  typeof raw === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.trim())
    ? { ok: true, value: raw.trim() }
    : { ok: false, error: "must be a hex color like #c2603c" };

/** Bounds on a free-form list field, for the same reason as {@link MAX_STRING_CHARS}. */
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_CHARS = 256;

const stringList = (raw: unknown): Coerced => {
  const list = sanitizeAllowedTypes(raw);
  if (!list) return { ok: false, error: "must be a non-empty list of type/extension strings" };
  if (list.length > MAX_LIST_ITEMS) return { ok: false, error: `must have at most ${MAX_LIST_ITEMS} entries` };
  if (list.some((s) => s.length > MAX_LIST_ITEM_CHARS)) {
    return { ok: false, error: `each entry must be at most ${MAX_LIST_ITEM_CHARS} characters` };
  }
  return { ok: true, value: list };
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
  { key: "selfMcpProjectsEnabled", group: "capabilities", label: "Self-management MCP (projects)", help: "Let keepers create new projects and promote existing ones — including a git clone of a repo URL the agent supplies (needs self-MCP write).", type: "boolean", envVars: ["PADDOCK_SELF_MCP_PROJECTS"], default: false, editable: true, coerce: asBool },
  { key: "maxSpawnDepth", group: "capabilities", label: "Max spawn depth", help: "How deep a spawn tree may grow before children lose the self-MCP.", type: "number", envVars: ["PADDOCK_MAX_SPAWN_DEPTH"], default: DEFAULT_MAX_SPAWN_DEPTH, editable: true, coerce: spawnDepth },
  { key: "scheduleMutationEnabled", group: "capabilities", label: "Schedule mutation", help: "Allow programmatic schedule add/remove at runtime.", type: "boolean", envVars: ["PADDOCK_SCHEDULE_MUTATION"], default: false, editable: true, coerce: asBool },
  { key: "hooksMcpEnabled", group: "capabilities", label: "Hooks MCP", help: "Let agents declare/edit their own event hooks (needs self-MCP write).", type: "boolean", envVars: ["PADDOCK_HOOKS_MCP"], default: false, editable: true, coerce: asBool },
  { key: "browserMcp", group: "capabilities", label: "Browser MCP (Playwright)", help: "Give agents a headless Chromium browser MCP.", type: "boolean", envVars: ["PADDOCK_BROWSER_MCP"], envShadowWhenDefined: true, default: false, editable: true, coerce: asBool },

  // Recovery (issue #301).
  { key: "recovery.surfaceKilledTask", group: "recovery", label: "Surface killed task", type: "boolean", envVars: ["PADDOCK_RECOVERY_SURFACE"], default: DEFAULT_RECOVERY.surfaceKilledTask, editable: true, coerce: asBool },
  { key: "recovery.autoReDrive", group: "recovery", label: "Auto re-drive", type: "boolean", envVars: ["PADDOCK_RECOVERY_AUTODRIVE"], default: DEFAULT_RECOVERY.autoReDrive, editable: true, coerce: asBool },
  { key: "recovery.debounceMs", group: "recovery", label: "Debounce (ms)", type: "number", envVars: ["PADDOCK_RECOVERY_DEBOUNCE_MS"], default: DEFAULT_RECOVERY.debounceMs, editable: true, coerce: nonNegInt },
  { key: "recovery.maxRetries", group: "recovery", label: "Max retries", type: "number", envVars: ["PADDOCK_RECOVERY_MAX_RETRIES"], default: DEFAULT_RECOVERY.maxRetries, editable: true, coerce: nonNegInt },

  // Attachments (issue #328).
  { key: "attachments.enabled", group: "attachments", label: "Enabled", type: "boolean", envVars: ["PADDOCK_ATTACHMENTS_ENABLED"], default: DEFAULT_ATTACHMENTS.enabled, editable: true, coerce: asBool },
  { key: "attachments.maxFileSizeMb", group: "attachments", label: "Max file size (MB)", type: "number", envVars: ["PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB"], default: DEFAULT_ATTACHMENTS.maxFileSizeMb, editable: true, coerce: posInt },
  { key: "attachments.maxFilesPerMessage", group: "attachments", label: "Max files / message", type: "number", envVars: ["PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE"], default: DEFAULT_ATTACHMENTS.maxFilesPerMessage, editable: true, coerce: posInt },
  { key: "attachments.allowedTypes", group: "attachments", label: "Allowed types", help: "MIME types / extensions (e.g. image/*, .pdf). * = allow all.", type: "string-list", envVars: ["PADDOCK_ATTACHMENTS_ALLOWED_TYPES"], default: [...DEFAULT_ATTACHMENTS.allowedTypes], editable: true, coerce: stringList },

  // Branding (issue #34).
  { key: "brand.name", group: "branding", label: "Name", type: "string", envVars: ["PADDOCK_BRAND_NAME"], default: "Paddock", editable: true, coerce: nonEmptyString },
  { key: "brand.logo", group: "branding", label: "Logo", help: "An emoji/glyph, or a URL/path to an image.", type: "string", envVars: ["PADDOCK_BRAND_LOGO"], default: "🐎", editable: true, coerce: nonEmptyString },
  { key: "brand.accent", group: "branding", label: "Accent color", type: "string", envVars: ["PADDOCK_BRAND_ACCENT"], default: "#c2603c", editable: true, coerce: hexColor },

  // Onboarding (issue #865). Written by the root Home's close button rather than
  // by hand, and this row is the "restore" the design promises: turning it OFF
  // puts the slideshow back on Home for everyone.
  { key: "gettingStartedDismissed", group: "onboarding", label: "Getting started dismissed", help: "On = the Getting Started slideshow on the root workspace's Home stays closed. Turn it off to show it again.", type: "boolean", envVars: ["PADDOCK_GETTING_STARTED_DISMISSED"], liveReload: true, default: false, editable: true, coerce: asBool },

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
  { key: "port", group: "advanced", label: "Port", type: "number", envVars: ["PORT"], default: 7233, editable: false },
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
  // Read-only for the same reason, plus one of its own: the secure-storage
  // variable it sets is read by Claude Code when a turn's process starts, so a
  // live toggle would apply to some turns and not others.
  { key: "claude.credentials", group: "advanced", label: "Credentials", help: "host = this machine's Claude Code login (macOS Keychain, or your ~/.claude/.credentials.json); own = only a login of this instance's.", type: "string", envVars: ["PADDOCK_CLAUDE_CREDENTIALS"], default: DEFAULT_CREDENTIALS_MODE, editable: false },
  // Read-only for the same reasons. `hooks` is the one worth finding here even
  // though it cannot be changed here: "does this instance run the shell commands
  // my ~/.claude/settings.json binds to tool use?" is a question with a security
  // answer, and it should be readable without opening a YAML file.
  { key: "claude.instructions", group: "advanced", label: "Instructions", help: "own = this instance's own only; host = your ~/.claude CLAUDE.md, agents/, commands/ and plugins/ as well.", type: "string", envVars: ["PADDOCK_CLAUDE_INSTRUCTIONS"], default: DEFAULT_INSTRUCTIONS_MODE, editable: false },
  { key: "claude.hooks", group: "advanced", label: "Hooks", help: "own = your ~/.claude/settings.json hooks do NOT run here (its other keys still apply); host = they do.", type: "string", envVars: ["PADDOCK_CLAUDE_HOOKS"], default: DEFAULT_HOOKS_MODE, editable: false },
  // The fifth lever, which step 5 shipped without surfacing here. Read-only like
  // its four siblings, and worth the row for the same reason `hooks` is: an MCP
  // server is a process this instance spawns, so "is this instance running my
  // machine's MCP servers?" should be answerable without opening a YAML file.
  //
  // NOTE what is deliberately absent: the top-level `mcpServers:` block (#691
  // step 6), which declares servers rather than borrowing them. Its values hold
  // resolved credentials — an MCP server's `env` is where a stdio server's API
  // token lives — and every field in this table is serialised verbatim into the
  // GET response, so a row for it would publish tokens to any authenticated UI
  // user. There is no redacting variant of `FieldSpec`, and inventing one to
  // display a server list is not worth the leak surface: the boot log already
  // names every declared server, secret-free, via `describeServer`.
  { key: "claude.mcpServers", group: "advanced", label: "MCP servers", help: "own = only the servers Paddock provides itself; host = the ones declared in your ~/.claude.json as well.", type: "string", envVars: ["PADDOCK_CLAUDE_MCP_SERVERS"], default: DEFAULT_MCP_SERVERS_MODE, editable: false },
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
  /** EFFECTIVE now: the value the running (frozen) process resolved at boot. */
  value: unknown;
  /**
   * PENDING: what this field would resolve to if the process restarted right
   * now — i.e. what is in `paddock.config.yaml` this instant (or the built-in
   * default where the file says nothing, or `value` where an env var wins). This
   * is what the editor renders and what a save round-trips through (#722).
   */
  pendingValue: unknown;
  /** `pendingValue` differs from `value` — the file has diverged from the process. */
  pendingRestart: boolean;
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
  /**
   * At least one editable field's `pendingValue` differs from its `value`: the
   * file on disk no longer describes the running process, and a restart would
   * change behaviour. Was hardcoded `false` before #722 — which meant nothing
   * ever told an operator their own save was unapplied.
   */
  restartRequired: boolean;
  /**
   * Fingerprint of the config file as read for THIS response (`null` when the
   * file does not exist yet). A client echoes it back as `expectedVersion` on
   * the PUT; the server refuses the write if the file changed meanwhile, so two
   * tabs conflict loudly instead of silently last-writer-winning (#722).
   */
  configVersion: string | null;
  /**
   * Set when the file exists but could not be read or parsed. Pending values are
   * unknowable in that state, so they fall back to the effective ones — better
   * to say why than to silently report "nothing pending".
   */
  configFileError?: string;
}

/** The config file as read for a GET: its parsed body plus a fingerprint. */
interface ConfigFileSnapshot {
  /** Parsed mapping, or `null` when the file is absent/empty/unreadable. */
  data: Record<string, unknown> | null;
  /** Content fingerprint, or `null` when the file is absent. */
  version: string | null;
  /** Why `data` is null despite the file existing. */
  error?: string;
}

/**
 * Read + parse `paddock.config.yaml` for the GET path. Never throws: a missing
 * file is the normal case, and a malformed one must not take down the screen
 * that exists to fix it (the boot loader is the strict reader — see
 * `loadConfigFile`).
 */
function readConfigFileSnapshot(configPath: string): ConfigFileSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { data: null, version: null };
    return { data: null, version: null, error: `failed to read ${configPath}: ${(err as Error).message}` };
  }
  const version = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    return { data: null, version, error: `failed to parse ${configPath}: ${(err as Error).message}` };
  }
  // Empty / comments-only file → no overrides, same reading as loadConfigFile.
  if (parsed === null || parsed === undefined) return { data: {}, version };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: null, version, error: `${configPath} is not a YAML mapping` };
  }
  return { data: parsed as Record<string, unknown>, version };
}

/**
 * The current fingerprint of the config file (`null` when absent) — the PUT
 * path's half of the optimistic-concurrency check. Deliberately re-reads rather
 * than trusting a cached value: the point is to notice a write we did not make.
 */
export function instanceConfigVersion(configPath: string): string | null {
  return readConfigFileSnapshot(configPath).version;
}

/** Structural equality for the value shapes a field can hold (scalars + string lists). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
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
 * Build the grouped GET DTO from the resolved (frozen) config, the live env AND
 * the config file on disk. Each field reports:
 *
 *  - `value` — EFFECTIVE now, out of the frozen boot config;
 *  - `pendingValue` — what a restart would resolve, out of the file this instant;
 *  - `pendingRestart` — those two differ.
 *
 * Reading the file is the load-bearing part (#722). While this built the DTO
 * from the frozen config alone, `GET` could not observe ANY write — including
 * the one the caller had just made — so a successful save appeared to revert,
 * two tabs clobbered each other with nothing able to notice, and
 * `restartRequired` had no choice but to be a hardcoded `false`.
 *
 * Pending values are computed for EDITABLE, non-env-shadowed fields only:
 *  - an env-shadowed field resolves to the same env value after a restart, so
 *    the file cannot make it diverge;
 *  - the read-only `advanced` bindings are normalised at boot (`dataDir` and
 *    friends are canonicalised, `port` is `Number()`-ed), so comparing them
 *    against raw file text would manufacture divergence that isn't there.
 */
export function buildInstanceConfig(cfg: PaddockConfig): InstanceConfigDto {
  const groups: InstanceConfigGroupDto[] = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    description: g.description,
    fields: [],
  }));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const configPath = instanceConfigPath(cfg);
  const file = readConfigFileSnapshot(configPath);
  let restartRequired = false;

  for (const f of FIELDS) {
    const shadow = envOverride(f.envVars, f.envShadowWhenDefined);
    const raw = readPath(cfg, f.key);
    // `undefined` (e.g. sweepMinIntervalMs unset, optional endpoint) → null so
    // it JSON-serializes as an explicit absence rather than dropping the key.
    const value = raw === undefined ? null : raw;

    let pendingValue: unknown = value;
    let pendingRestart = false;
    if (f.editable && shadow === undefined && file.data) {
      // Absent, or present-but-null (`debounceMs:` with nothing after it), both
      // mean "no override" — `fileOr`/`fileOpt` degrade a null to the default.
      const fileRaw = readPath(file.data, f.key);
      pendingValue = fileRaw == null ? (f.default ?? null) : coerceForDisplay(f, fileRaw);
      // A field the frozen config leaves unset IS its built-in default (that is
      // what `default` documents), so normalise before comparing — otherwise
      // e.g. `models`, unset and therefore null, would read as forever diverging
      // from the catalog list the file's absence implies.
      const effective = value === null ? (f.default ?? null) : value;
      // A `liveReload` field's consumer reads the file directly, so a divergence
      // here is already in effect and has no restart to wait for (#865).
      pendingRestart = f.liveReload !== true && !valuesEqual(pendingValue, effective);
      if (pendingRestart) restartRequired = true;
    }

    const dto: InstanceConfigFieldDto = {
      key: f.key,
      group: f.group,
      label: f.label,
      help: f.help,
      type: f.type,
      enumValues: f.enumValues,
      value,
      pendingValue,
      pendingRestart,
      default: f.default,
      editable: f.editable,
      sensitive: f.sensitive ?? false,
      envOverridden: shadow !== undefined,
      envVar: shadow,
    };
    groupById.get(f.group)?.fields.push(dto);
  }

  return {
    groups,
    configPath,
    restartRequired,
    configVersion: file.version,
    ...(file.error ? { configFileError: file.error } : {}),
  };
}

/**
 * Normalise a value read back out of the file into the shape the writer would
 * have produced, so a hand-typed `"1234"` doesn't read as diverging from a
 * written `1234`. A value the field's own validator rejects is reported
 * verbatim: the file really does say that, and the screen showing it is how an
 * operator finds out (the boot loader would degrade it to the default).
 */
function coerceForDisplay(f: FieldSpec, raw: unknown): unknown {
  if (!f.coerce) return raw;
  const res = f.coerce(raw);
  return res.ok ? res.value : raw;
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
 *  - a key an env var currently shadows,
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
    // `env > file > default`: writing a shadowed field to the file changes
    // nothing an operator can observe, now or after a restart. The UI already
    // renders these read-only; without this check the API happily returned 200 +
    // `restartRequired: true` for a write that could never take effect.
    const shadow = envOverride(spec.envVars, spec.envShadowWhenDefined);
    if (shadow !== undefined) {
      throw new InstanceConfigError(
        `${spec.label} (${key}) is set by the environment variable ${shadow}, which wins over the config file — change it there instead`,
        key,
      );
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

  // Stamp the schema version on a file that does not declare one yet (#724) —
  // which includes every file written before adoption and every fresh one this
  // branch creates. Written only when ABSENT, unlike `project.yaml`: this is a
  // partial patch over a document whose other keys are round-tripped untouched,
  // so it is not in a position to assert what version the WHOLE file is. A file
  // that already declares one has been through `loadConfigFile`'s guard, so it
  // is at or below this build's version and re-stamping would say nothing new.
  if (doc.getIn([SCHEMA_VERSION_KEY]) === undefined) {
    doc.setIn([SCHEMA_VERSION_KEY], CONFIG_SCHEMA_VERSION);
  }

  const serialized = doc.toString();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Atomic write: same-dir temp file + rename, so a reader never sees a
  // half-written config (rename is atomic on the same filesystem).
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, configPath);
}
