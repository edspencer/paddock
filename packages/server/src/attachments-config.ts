/**
 * Inbound attachment config — the config foundation for issue #328 Phase 1
 * (ChatGPT-style file/image upload in the composer, "Approach A").
 *
 * ── What this governs ────────────────────────────────────────────────────────
 * A user can pick / drag / paste files into the composer; each is copied into the
 * per-instance attachment store (reusing the `send_file` store, #112) and the
 * keeper is pointed at the absolute paths so its `Read` tool can view them
 * (native vision on images/PDFs). This module resolves the four knobs that gate
 * that flow: whether it's enabled at all, a per-file size cap, a per-message file
 * count cap, and an allow-list of file types.
 *
 * ── Config discipline (the `recovery`/`driveMode` pattern) ───────────────────
 * Every field is an instance default (`PADDOCK_ATTACHMENTS_*` env, YAML instance
 * file beneath it) with an optional PER-PROJECT override (`project.yaml` →
 * {@link import("./projects.js").ProjectYaml.attachments}). An absent/invalid
 * override field inherits the instance default, resolved at request time by
 * {@link resolveAttachmentsConfig} — never baked into the DTO (mirrors how
 * `recovery` resolves via {@link import("./recovery-config.js").resolveRecoveryConfig}).
 * A malformed override is ignored rather than fatal so a hand-edited `project.yaml`
 * can't wedge an upload.
 *
 * ── allowedTypes semantics ───────────────────────────────────────────────────
 * Each entry is either a MIME pattern (contains `/`, `*` wildcards a segment —
 * `image/*`, `*​/*`) or an extension (starts with `.` — `.csv`, `.ipynb`). A file
 * is allowed if its MIME matches any MIME pattern OR its extension matches any
 * extension entry. The sentinel `"*"` (or `"*​/*"`) allows everything (the
 * default). The extension fallback matters because browsers report empty/generic
 * MIME for many real attachments (`.md`, `.ts`, `.heic` → `""`/`text/plain`).
 *
 * NOTE: `File.type` / multipart content-type are client-provided and spoofable,
 * so allowedTypes is a hygiene/UX guardrail, NOT a security boundary (no
 * magic-byte sniffing in v1) — appropriate for a personal/LAN tool.
 */

/**
 * Resolved attachment config — all fields concrete. Held on {@link
 * import("./config.js").PaddockConfig.attachments} (instance defaults) and
 * produced per-request by {@link resolveAttachmentsConfig} (project override else
 * instance).
 */
export interface AttachmentsConfig {
  /**
   * Master switch for inbound composer uploads. Default ON. When off, the upload
   * endpoint 403s and the composer hides its picker/drop/paste affordances. Env
   * `PADDOCK_ATTACHMENTS_ENABLED`.
   */
  enabled: boolean;
  /**
   * Per-file size cap in megabytes (1 MB = 1024*1024 bytes). A larger file is
   * rejected before it's written. Default 25. Env
   * `PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB`.
   */
  maxFileSizeMb: number;
  /**
   * How many files a single message may carry. Enforced client-side (tray cap)
   * and server-side (per upload request + at send). Default 10. Env
   * `PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE`.
   */
  maxFilesPerMessage: number;
  /**
   * Allow-list of MIME patterns / extensions (see the module doc). Default
   * `["*"]` (allow everything). Env `PADDOCK_ATTACHMENTS_ALLOWED_TYPES`
   * (comma-separated); YAML/project take a real array.
   */
  allowedTypes: string[];
}

/**
 * A per-project attachment override as stored in `project.yaml` — every field
 * optional (an absent field inherits the instance default at request time).
 */
export type AttachmentsOverride = Partial<AttachmentsConfig>;

/**
 * The built-in attachment defaults (beneath env + YAML + per-project override):
 * enabled, 25 MB/file, 10 files/message, allow-all.
 */
export const DEFAULT_ATTACHMENTS: AttachmentsConfig = Object.freeze({
  enabled: true,
  maxFileSizeMb: 25,
  maxFilesPerMessage: 10,
  allowedTypes: Object.freeze(["*"]) as unknown as string[],
});

/** 1 MB in bytes — the unit `maxFileSizeMb` is expressed in. */
export const BYTES_PER_MB = 1024 * 1024;

/** The per-file size cap in BYTES for a resolved config. */
export function maxFileBytes(cfg: AttachmentsConfig): number {
  return cfg.maxFileSizeMb * BYTES_PER_MB;
}

/** True when `n` is a valid positive integer knob (size/count must be ≥ 1). */
function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && Number.isFinite(n);
}

/**
 * Normalise an allowedTypes list: keep only non-blank strings, trimmed and
 * lower-cased (MIME + extensions are case-insensitive). Returns `undefined` when
 * nothing valid remains (so an empty list never silently means "deny all").
 */
export function sanitizeAllowedTypes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Validate + normalise an untrusted value (from `project.yaml` or a PATCH body)
 * into an {@link AttachmentsOverride}, dropping any field that is missing or
 * invalid, and returning `undefined` when nothing valid remains (so an empty
 * override is never persisted). `enabled` must be a real boolean; the numeric
 * knobs must be positive integers; `allowedTypes` must be a non-empty string
 * array. Defensive by design — a malformed hand-edit degrades to "inherit the
 * instance default", never a crash.
 */
export function sanitizeAttachmentsOverride(value: unknown): AttachmentsOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const out: AttachmentsOverride = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (isPositiveInt(o.maxFileSizeMb)) out.maxFileSizeMb = o.maxFileSizeMb;
  if (isPositiveInt(o.maxFilesPerMessage)) out.maxFilesPerMessage = o.maxFilesPerMessage;
  const types = sanitizeAllowedTypes(o.allowedTypes);
  if (types) out.allowedTypes = types;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the effective attachment config for a request: a valid per-project
 * override wins field-by-field; every absent field inherits the instance default.
 * Mirrors how `recovery`/`driveMode` resolve — the override is carried on disk
 * only for the fields explicitly set, so an absent value transparently inherits
 * the instance (env/YAML) default. The override is re-sanitised so a corrupt
 * on-disk value can't leak through.
 */
export function resolveAttachmentsConfig(
  override: AttachmentsOverride | undefined,
  instanceDefault: AttachmentsConfig,
): AttachmentsConfig {
  const clean = sanitizeAttachmentsOverride(override) ?? {};
  return {
    enabled: clean.enabled ?? instanceDefault.enabled,
    maxFileSizeMb: clean.maxFileSizeMb ?? instanceDefault.maxFileSizeMb,
    maxFilesPerMessage: clean.maxFilesPerMessage ?? instanceDefault.maxFilesPerMessage,
    allowedTypes: clean.allowedTypes ?? instanceDefault.allowedTypes,
  };
}

/** The extension of a filename, lower-cased, WITH the leading dot (`.csv`), or "". */
function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // No dot, or a dotfile with no extension (`.gitignore` → treat as no ext).
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * Does a concrete `mime` (e.g. `image/png`) match a MIME PATTERN entry (e.g.
 * `image/*`, `*​/*`, `text/csv`)? `*` wildcards a whole segment. Both are
 * lower-cased by the caller / sanitiser. A blank mime never matches a pattern
 * (fall back to the extension test instead).
 */
function mimeMatches(pattern: string, mime: string): boolean {
  if (!mime) return false;
  const [pType, pSub] = pattern.split("/", 2);
  const [mType, mSub] = mime.split("/", 2);
  const seg = (p: string | undefined, m: string | undefined): boolean =>
    p === "*" || p === m;
  return seg(pType, mType) && seg(pSub, mSub);
}

/**
 * True when a file (identified by its browser-reported `mime` and its
 * `filename`) is allowed by `allowedTypes`. Allowed if any entry matches: a
 * MIME-pattern entry (contains `/`) is tested against `mime`; an extension entry
 * (starts with `.`) against the filename's extension. The sentinel `"*"` /
 * `"*​/*"` allows everything. See the module doc for why the extension fallback
 * exists. `mime`/`filename` may be empty (browsers often omit one).
 */
export function isTypeAllowed(
  allowedTypes: string[],
  mime: string | undefined,
  filename: string | undefined,
): boolean {
  const m = (mime ?? "").trim().toLowerCase();
  const ext = extensionOf(filename ?? "");
  for (const raw of allowedTypes) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    // Allow-all sentinels.
    if (entry === "*" || entry === "*/*") return true;
    if (entry.includes("/")) {
      if (mimeMatches(entry, m)) return true;
    } else if (entry.startsWith(".")) {
      if (ext && ext === entry) return true;
    } else {
      // A bare token (e.g. "png") — tolerate it as an extension match.
      if (ext && ext === `.${entry}`) return true;
    }
  }
  return false;
}
