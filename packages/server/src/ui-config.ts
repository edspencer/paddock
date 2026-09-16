/**
 * Instance-level UI knobs (issue #914) — settings that shape how the SPA renders,
 * as opposed to what the server will do. Instance-level only: there is deliberately
 * no per-project override, because these describe the operator's browser/box
 * tolerance rather than anything about a project's content.
 *
 * Kept as its own block module per the one-file-per-config-block convention (cf.
 * `attachments-config.ts`, `recovery-config.ts`).
 */

/**
 * Resolved UI config — all fields concrete. Held on
 * {@link import("./config.js").PaddockConfig.ui} and served to the SPA as
 * `uiDefault` on `GET /api/models`.
 */
export interface UiConfig {
  /**
   * How many trailing messages a chat's transcript renders on open.
   *
   * A long-running chat is ~1,500 turns, and mounting all of them is what makes
   * switching into one slow (#914). The cap is applied at the `/messages` join,
   * so it also bounds the server-side enrich/provenance/serialise work — not just
   * the DOM.
   *
   * **`0` means unlimited** (render everything, the pre-#914 behaviour), so this
   * is a NON-NEGATIVE integer knob — unlike the attachment counts, `1` is not the
   * floor. Default 500. Env `PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT`.
   *
   * This is a *render* cap, not a retention policy: nothing is deleted, and the
   * full transcript is always one uncapped fetch away (#915).
   */
  transcriptRenderLimit: number;
}

/** The built-in UI defaults (beneath env + YAML): last 500 messages rendered. */
export const DEFAULT_UI: UiConfig = Object.freeze({
  transcriptRenderLimit: 500,
});

/**
 * Apply a transcript render cap to a message list: the trailing `limit`, or the
 * whole list when `limit` is 0 (unlimited) or the list already fits.
 *
 * Split out as a pure function so the slice semantics are unit-testable without
 * a transcript on disk, and so the route and any future caller cannot disagree
 * about what "the last N" means.
 */
export function capMessages<T>(messages: T[], limit: number): T[] {
  if (!Number.isInteger(limit) || limit <= 0) return messages;
  if (messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}
