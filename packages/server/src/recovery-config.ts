/**
 * Keeper-chat recovery config — the shared foundation for issue #301 (Phase 0).
 *
 * ── The problem (see edspencer/herdctl#374) ──────────────────────────────────
 * When a keeper launches a BACKGROUND task (background `Bash`, or a background
 * `Task`/`Agent`) and ends its turn while that task is still running, herdctl
 * correctly keeps the session ALIVE at the turn boundary (it sees the running
 * task in the Stop snapshot and does not reap). But the SDK/native binary kills
 * the still-running background child ~2–8s later anyway. A COMPLETED task emits a
 * re-invocation turn and the keeper continues; a KILLED task emits no wake at all
 * — the `killed`/`stopped` `<task-notification>` is written to the transcript but
 * nothing consumes it. The keeper is left alive-but-idle-forever, recovering only
 * when a human sends the next message. Because the session stays injectable, the
 * whole class of workarounds is "automate (or one-click) the nudge a human sends."
 *
 * ── The two configurable layers ──────────────────────────────────────────────
 * This ticket adds an app-side recovery mechanism in two independently-toggleable
 * layers, each resolved here:
 *
 *   Layer 2 ({@link RecoveryConfig.surfaceKilledTask}, default ON) — pure
 *     visibility + a manual one-click "Continue". Low-risk, so on by default.
 *   Layer 3 ({@link RecoveryConfig.autoReDrive}, default OFF) — automatic
 *     detection + re-drive of a hung keeper. Costs a turn/tokens and acts on its
 *     own, so opt-in. The DETECTION/INJECT ENGINE is a FOLLOW-UP chat; this
 *     module only defines + resolves the flag so the config surface exists.
 *
 * ── Config discipline (the `driveMode`/`maxSpawnDepth` pattern) ───────────────
 * Every field is an instance default (`PADDOCK_RECOVERY_*` env, YAML instance
 * file beneath it) with an optional PER-PROJECT override (`project.yaml` →
 * {@link import("./projects.js").ProjectYaml.recovery}). An absent/invalid
 * override inherits the instance default, resolved at dispatch by
 * {@link resolveRecoveryConfig} — never baked into the DTO (mirrors how
 * `driveMode` resolves against `cfg.keeperDriveMode` and `maxSpawnDepth` via
 * `resolveMaxSpawnDepth`). A malformed override is ignored rather than fatal so a
 * hand-edited `project.yaml` can't wedge dispatch.
 */

/**
 * Resolved recovery config — all fields concrete. Held on {@link
 * import("./config.js").PaddockConfig.recovery} (instance defaults) and produced
 * per-dispatch by {@link resolveRecoveryConfig} (project override else instance).
 */
export interface RecoveryConfig {
  /**
   * Layer 2 — render the killed/stopped `<task-notification>` as a distinct
   * "keeper is idle" affordance with a one-click Continue button, instead of
   * silently hiding it. Default ON (pure visibility + a manual button is
   * low-risk). Env `PADDOCK_RECOVERY_SURFACE`.
   */
  surfaceKilledTask: boolean;
  /**
   * Layer 3 — automatically re-drive a keeper whose background task was killed at
   * the turn boundary (detect + inject a nudge so it wakes on its own). Default
   * OFF (auto-acts and costs a turn/tokens → opt-in). Env
   * `PADDOCK_RECOVERY_AUTODRIVE`. NOTE: this chat only plumbs the flag; the
   * detection/inject engine lands in a follow-up.
   */
  autoReDrive: boolean;
  /**
   * Layer 3 guard — minimum ms of quiet after a killed-task notification before
   * the auto re-drive fires, so a genuinely-finishing keeper isn't poked. Default
   * 5000. Env `PADDOCK_RECOVERY_DEBOUNCE_MS`.
   */
  debounceMs: number;
  /**
   * Layer 3 guard — how many times a single hung session may be auto re-driven
   * before giving up, so a wedged keeper isn't poked in a loop. Default 1. Env
   * `PADDOCK_RECOVERY_MAX_RETRIES`.
   */
  maxRetries: number;
  /**
   * Layer 2 backstop — if a kept-alive keeper session shows no activity for this
   * many ms after a killed-task notification, surface it as stuck. `0` disables
   * the backstop (the default). Env `PADDOCK_RECOVERY_LIMBO_MS`.
   */
  limboTimeoutMs: number;
}

/**
 * A per-project recovery override as stored in `project.yaml` — every field
 * optional (an absent field inherits the instance default at dispatch).
 */
export type RecoveryOverride = Partial<RecoveryConfig>;

/**
 * The built-in recovery defaults (beneath env + YAML + per-project override).
 * Layer 2 ON, Layer 3 OFF, guards at their documented values.
 */
export const DEFAULT_RECOVERY: RecoveryConfig = Object.freeze({
  surfaceKilledTask: true,
  autoReDrive: false,
  debounceMs: 5000,
  maxRetries: 1,
  limboTimeoutMs: 0,
});

/** The `<status>` values a killed-at-turn-boundary task notification carries. */
const TERMINATED_STATUSES = new Set(["killed", "stopped"]);

/**
 * True when a `<task-notification>` `<status>` value denotes a task that was
 * TERMINATED (killed/stopped) — the turn-boundary-kill case #301 recovers from —
 * rather than a clean `completed` (or a still-`running`/`timed out` Monitor).
 * Case-insensitive; a missing/blank/other status is not terminated.
 */
export function isTerminatedTaskStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINATED_STATUSES.has(status.trim().toLowerCase());
}

/** True when `n` is a valid non-negative-integer ms/count knob. */
function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && Number.isFinite(n);
}

/**
 * Validate + normalise an untrusted value (from `project.yaml` or a PATCH body)
 * into a {@link RecoveryOverride}, dropping any field that is missing or invalid,
 * and returning `undefined` when nothing valid remains (so an empty override is
 * never persisted). Booleans must be real booleans; the numeric knobs must be
 * non-negative integers. Defensive by design — a malformed hand-edit degrades to
 * "inherit the instance default", never a startup/dispatch crash.
 */
export function sanitizeRecoveryOverride(value: unknown): RecoveryOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const out: RecoveryOverride = {};
  if (typeof o.surfaceKilledTask === "boolean") out.surfaceKilledTask = o.surfaceKilledTask;
  if (typeof o.autoReDrive === "boolean") out.autoReDrive = o.autoReDrive;
  if (isNonNegativeInt(o.debounceMs)) out.debounceMs = o.debounceMs;
  if (isNonNegativeInt(o.maxRetries)) out.maxRetries = o.maxRetries;
  if (isNonNegativeInt(o.limboTimeoutMs)) out.limboTimeoutMs = o.limboTimeoutMs;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the effective recovery config for a dispatch: a valid per-project
 * override wins field-by-field; every absent field inherits the instance default.
 * Mirrors how `driveMode`/`maxSpawnDepth` resolve — the override is carried on
 * disk only for the fields explicitly set, so an absent value transparently
 * inherits the instance (env/YAML) default. The override is re-sanitised so a
 * corrupt on-disk value can't leak through.
 */
export function resolveRecoveryConfig(
  override: RecoveryOverride | undefined,
  instanceDefault: RecoveryConfig,
): RecoveryConfig {
  const clean = sanitizeRecoveryOverride(override) ?? {};
  return {
    surfaceKilledTask: clean.surfaceKilledTask ?? instanceDefault.surfaceKilledTask,
    autoReDrive: clean.autoReDrive ?? instanceDefault.autoReDrive,
    debounceMs: clean.debounceMs ?? instanceDefault.debounceMs,
    maxRetries: clean.maxRetries ?? instanceDefault.maxRetries,
    limboTimeoutMs: clean.limboTimeoutMs ?? instanceDefault.limboTimeoutMs,
  };
}
