/**
 * Models module — the single source of truth for the Claude model ids paddock
 * exposes (keeper + sweeper defaults, the picker list, and per-model context
 * limits).
 *
 * The wire contract (CONTRACT-v3 §2/§3) and every consumer (the `/api/models`
 * route, the project `model` resolution in projects.ts, the keeper/sweeper
 * registration in herdctl.ts, and the context-meter math in ws.ts) read these
 * constants — so changing the available models or a context limit is a one-file
 * edit here.
 *
 * Context limits (verified against the Models API): Fable 5, Opus 4.8 and
 * Sonnet 5 all have a 1,000,000-token context window; Haiku 4.5 is 200,000. On
 * the Max/CLI runtime the keeper agents run Opus 4.8 at its full 1M window, so
 * the context meter must use 1M for it — otherwise a long chat reads >100%.
 */

/** A single selectable model: its id, a human label, and its context window. */
export interface ModelInfo {
  /** The Claude model id passed to herdctl / the SDK (e.g. "claude-opus-4-8"). */
  id: string;
  /** Human-friendly label for the picker (e.g. "Opus 4.8"). */
  label: string;
  /** Total context window in tokens (used for the context meter). */
  contextLimit: number;
}

/**
 * The selectable models, in picker order. The first entry is the keeper default
 * (Opus); the cheap Haiku is the sweeper default. Order here is the order the UI
 * renders.
 */
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 },
  { id: "claude-fable-5", label: "Fable 5", contextLimit: 1_000_000 },
  { id: "claude-sonnet-5", label: "Sonnet 5", contextLimit: 1_000_000 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", contextLimit: 200_000 },
];

/** The model a project's keeper agent uses unless the project overrides it. */
export const KEEPER_DEFAULT_MODEL = "claude-opus-4-8";

/**
 * Per-project keeper-agent settings surfaced in the project settings UI
 * (issue #12). These mirror the fleet-wide `defaults` in herdctl.ts so a project
 * that doesn't override a field inherits the same value it would have anyway —
 * they're the single source of truth for both the defaults block and the DTO
 * resolution.
 */

/**
 * The keeper `permission_mode` values offered in the settings UI. A curated
 * subset of herdctl's PermissionMode enum (default / acceptEdits / plan /
 * bypassPermissions) — the niche delegate/dontAsk modes are omitted.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Keeper defaults (inherited when a project doesn't override the field). */
export const KEEPER_DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";
export const KEEPER_DEFAULT_MAX_TURNS = 200;
export const KEEPER_DEFAULT_DOCKER = false;

/** Upper bound on a project's `max_turns` (guards the UI + PATCH validation). */
export const MAX_TURNS_LIMIT = 1000;

/** Whether `m` is one of the offered keeper permission modes. */
export function isKnownPermissionMode(m: string): m is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(m);
}

/** Whether `n` is a valid keeper `max_turns` (positive integer within bounds). */
export function isValidMaxTurns(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_TURNS_LIMIT;
}

/** The cheap model the post-turn sweeper (curator) always uses. */
export const SWEEPER_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Default context limit when a model id is unknown (every current model is 200k). */
const DEFAULT_CONTEXT_LIMIT = 200000;

/** Whether `id` is one of the known selectable models. */
export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

/**
 * The context limit (in tokens) for a model id. Falls back to 200000 for an
 * unknown id so the context meter never divides by an undefined/zero limit.
 */
export function getContextLimit(id: string): number {
  return MODELS.find((m) => m.id === id)?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
}

/** The full ModelInfo for a model id, or undefined if it isn't a known model. */
export function getModelInfo(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
