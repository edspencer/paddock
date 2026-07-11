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

/**
 * Public first-party API list price per 1M tokens, used only to put a
 * ballpark dollar figure on a chat's cumulative token consumption (issue #152).
 * On the Max/CLI runtime the keeper agents don't draw against a per-token
 * quota, so this is an "at API rates" estimate for comparison, not real spend —
 * the token counts are the honest metric. Cache-write / cache-read rates are the
 * standard multiples of the input rate (5-minute ephemeral write = 1.25×, read =
 * 0.1×), applied in {@link estimateCostUsd}.
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/** A single selectable model: its id, a human label, and its context window. */
export interface ModelInfo {
  /** The Claude model id passed to herdctl / the SDK (e.g. "claude-opus-4-8"). */
  id: string;
  /** Human-friendly label for the picker (e.g. "Opus 4.8"). */
  label: string;
  /** Total context window in tokens (used for the context meter). */
  contextLimit: number;
  /** First-party list price per 1M tokens, for the cumulative-cost estimate. */
  pricing?: ModelPricing;
}

/**
 * The selectable models, in picker order. The first entry is the keeper default
 * (Opus); the cheap Haiku is the sweeper default. Order here is the order the UI
 * renders.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    contextLimit: 1_000_000,
    pricing: { inputPer1M: 5, outputPer1M: 25 },
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    contextLimit: 1_000_000,
    pricing: { inputPer1M: 10, outputPer1M: 50 },
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    contextLimit: 1_000_000,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    contextLimit: 200_000,
    pricing: { inputPer1M: 1, outputPer1M: 5 },
  },
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

/**
 * How a keeper chat turn is driven (Paddock#111):
 *  - `batch`   — one-shot `FleetManager.trigger()` per turn (the legacy path);
 *                the `claude` process exits at the turn boundary, so scheduled
 *                wakeups / background tasks silently die.
 *  - `session` — a persistent, herdctl-managed `openChatSession` per turn
 *                (`manageLifecycle: true`); the session is reaped when idle and
 *                its timer-class wakeups are re-triggered through the scheduler,
 *                so cross-turn autonomy (`ScheduleWakeup`, `/loop`) actually
 *                works. See herdctl#307 (reaper) and herdctl#303 (SDK bump).
 */
export const DRIVE_MODES = ["batch", "session"] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];

/**
 * Default keeper drive mode. `batch` for now (§Paddock#111): merging the session
 * path changes nothing until a box opts in via `PADDOCK_KEEPER_DRIVE_MODE` or a
 * per-project override. May flip to `session` in a future release.
 */
export const KEEPER_DEFAULT_DRIVE_MODE: DriveMode = "batch";

/** Whether `m` is one of the offered keeper permission modes. */
export function isKnownPermissionMode(m: string): m is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(m);
}

/** Whether `m` is a known keeper drive mode. */
export function isKnownDriveMode(m: string): m is DriveMode {
  return (DRIVE_MODES as readonly string[]).includes(m);
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

/** Cache-write (5-minute ephemeral) is 1.25× the input rate; cache-read is 0.1×. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** The four cumulative token totals a chat's dollar estimate is priced from. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Ballpark USD cost of a chat's cumulative token consumption at first-party API
 * list prices, or `null` for a model with no known pricing. Each token class is
 * priced separately — input, output, cache-write (1.25× input) and cache-read
 * (0.1× input) — because a single grand sum of "context tokens" would both
 * double-count (each turn's input re-reflects the whole growing context, which
 * is why {@link TokenTotals} must come from a per-turn cumulative sum) and
 * misprice (output is 5× input, cache-read a tenth of it).
 */
export function estimateCostUsd(modelId: string, t: TokenTotals): number | null {
  const pricing = getModelInfo(modelId)?.pricing;
  if (!pricing) return null;
  const { inputPer1M, outputPer1M } = pricing;
  const usd =
    (t.inputTokens * inputPer1M +
      t.cacheCreationTokens * inputPer1M * CACHE_WRITE_MULTIPLIER +
      t.cacheReadTokens * inputPer1M * CACHE_READ_MULTIPLIER +
      t.outputTokens * outputPer1M) /
    1_000_000;
  return usd;
}

/**
 * Cost of a chat that may span several models, priced from each model's own
 * rate. A chat's turns can run on different models (the composer lets you switch
 * model per turn, and the project default may differ from what actually ran), so
 * pricing the whole chat at one model — e.g. the project default — misprices by
 * the ratio between them (a Haiku chat billed at Opus rates is 5× too high).
 * Keys are the `message.model` recorded on each assistant turn; totals for a
 * model with no known pricing are skipped. Returns the summed cost, or `null`
 * only when *no* group could be priced (so an entirely-unknown-model chat hides
 * its cost rather than showing $0.00).
 */
export function estimateCostUsdByModel(byModel: Record<string, TokenTotals>): number | null {
  let usd = 0;
  let priced = false;
  for (const [modelId, totals] of Object.entries(byModel)) {
    const c = estimateCostUsd(modelId, totals);
    if (c == null) continue;
    usd += c;
    priced = true;
  }
  return priced ? usd : null;
}
