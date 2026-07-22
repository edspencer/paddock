/**
 * Sweeper curation budgets — the per-file token limits the post-turn curator
 * keeps OVERVIEW.md / CHANGELOG.md / CLAUDE.md under (issue #379), with a
 * per-project override layer (issue #384).
 *
 * ── Config discipline (the `recovery`/`driveMode` pattern) ────────────────────
 * Every budget is an instance default (`PADDOCK_CURATION_*` env, YAML instance
 * file beneath it — resolved in config.ts's `loadCurationConfig`) with an
 * optional PER-PROJECT override (`project.yaml` →
 * {@link import("./projects.js").ProjectYaml.curation}). An absent/invalid
 * override inherits the instance default, resolved at sweep time by
 * {@link resolveCurationConfig} — never baked into the DTO (mirrors how
 * `recovery` resolves via `resolveRecoveryConfig`). A malformed override is
 * ignored rather than fatal so a hand-edited `project.yaml` can't wedge a sweep.
 *
 * #379 shipped these instance-only; #384 adds the override so a docs-heavy
 * project can raise its CHANGELOG budget (or a lean project tighten it) without
 * changing the fleet-wide default.
 */

/**
 * Resolved curation budgets — all fields concrete. Held on {@link
 * import("./config.js").PaddockConfig.curation} (instance defaults) and produced
 * per-sweep by {@link resolveCurationConfig} (project override else instance).
 */
export interface CurationConfig {
  /** Budget for OVERVIEW.md (regenerated wholesale each sweep). */
  overviewMaxTokens: number;
  /** Budget for CHANGELOG.md (injected into the preload; the biggest lever). */
  changelogMaxTokens: number;
  /** Budget for the CLAUDE.md curated-notes section (auto-loaded every turn). */
  claudeMaxTokens: number;
}

/**
 * A per-project curation override as stored in `project.yaml` — every field
 * optional (an absent field inherits the instance default at sweep time).
 */
export type CurationOverride = Partial<CurationConfig>;

/** Built-in defaults when neither env nor YAML nor a project override sets a budget. */
export const DEFAULT_CURATION: CurationConfig = Object.freeze({
  overviewMaxTokens: 2000,
  changelogMaxTokens: 8000,
  claudeMaxTokens: 6000,
});

/** True when `n` is a usable budget: a positive, finite integer. */
function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && Number.isFinite(n);
}

/**
 * Validate + normalise an untrusted value (from `project.yaml` or a PATCH body)
 * into a {@link CurationOverride}, dropping any field that is missing or invalid,
 * and returning `undefined` when nothing valid remains (so an empty override is
 * never persisted). Each budget must be a positive integer. Defensive by design —
 * a malformed hand-edit degrades to "inherit the instance default", never a
 * sweep crash.
 */
export function sanitizeCurationOverride(value: unknown): CurationOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const out: CurationOverride = {};
  if (isPositiveInt(o.overviewMaxTokens)) out.overviewMaxTokens = o.overviewMaxTokens;
  if (isPositiveInt(o.changelogMaxTokens)) out.changelogMaxTokens = o.changelogMaxTokens;
  if (isPositiveInt(o.claudeMaxTokens)) out.claudeMaxTokens = o.claudeMaxTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the effective curation budgets for a sweep: a valid per-project
 * override wins field-by-field; every absent field inherits the instance default
 * (which is itself `env > paddock.config.yaml > built-in default`). The override
 * is re-sanitised so a corrupt on-disk value can't leak through.
 */
export function resolveCurationConfig(
  override: CurationOverride | undefined,
  instanceDefault: CurationConfig,
): CurationConfig {
  const clean = sanitizeCurationOverride(override) ?? {};
  return {
    overviewMaxTokens: clean.overviewMaxTokens ?? instanceDefault.overviewMaxTokens,
    changelogMaxTokens: clean.changelogMaxTokens ?? instanceDefault.changelogMaxTokens,
    claudeMaxTokens: clean.claudeMaxTokens ?? instanceDefault.claudeMaxTokens,
  };
}
