/**
 * Chat-verdict judge config — the instance knobs for the post-turn judge that
 * labels a chat "finished" or "could continue" (see `chat-judge.ts`).
 *
 * Instance-level only, like `ui-config.ts`: there is no per-project override.
 * Kept as its own block module per the one-file-per-config-block convention (cf.
 * `curation-config.ts`, `recovery-config.ts`).
 */
import { SWEEPER_DEFAULT_MODEL } from "./models.js";

/**
 * Resolved judge config — all fields concrete. Held on
 * {@link import("./config.js").PaddockConfig.judge}.
 */
export interface JudgeConfig {
  /**
   * Whether a cheap model judges each chat after its turn completes. Default
   * on. Env `PADDOCK_JUDGE_ENABLED` (1/true/yes enable; any other set value
   * disables). Off means no `judge-<slug>` agent is registered and no run is
   * ever made; verdicts already stored still render.
   */
  enabled: boolean;
  /**
   * The model the `judge-<slug>` agents are registered at. Applied at agent
   * registration (boot / `ensureProjectAgent`), because herdctl's one-shot
   * `trigger()` has no per-run model override. Must be a catalog id; an unknown
   * one falls back to the default. Env `PADDOCK_JUDGE_MODEL`.
   */
  model: string;
}

/** The built-in judge defaults: on, on the sweeper's cheap model. */
export const DEFAULT_JUDGE: JudgeConfig = Object.freeze({
  enabled: true,
  model: SWEEPER_DEFAULT_MODEL,
});
