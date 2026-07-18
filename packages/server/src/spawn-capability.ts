/**
 * Spawn capability — depth-gated self-MCP injection (issue #262 / DD-3, DD-5).
 *
 * A1 (#261) threaded an `origin` + spawn `depth` marker through every
 * server-initiated turn and persisted it to {@link RunProvenanceStore}. B1 (this
 * ticket) reads that `depth` to decide whether a SPAWNED turn is handed the
 * self-management MCP — crucially its WRITE tools, so `send_message` exists and a
 * child can finally report back to its parent (impossible today, where a spawned
 * chat gets `send_file` only).
 *
 * ── The bound ────────────────────────────────────────────────────────────────
 * A spawned/scheduled turn running in a chat at depth `d` receives the self-MCP
 * iff `d <= maxSpawnDepth`:
 *
 *   maxSpawnDepth = 0  → no spawned child gets the self-MCP (send_file only).
 *                        This reproduces EXACTLY today's behaviour.
 *   maxSpawnDepth = 1  → depth-1 children DO get it (a manager's children can
 *                        report back AND spawn), but depth-2 grandchildren do NOT.
 *                        This is the DEFAULT — the manager→children→report-back
 *                        pattern works out of the box while the tree can't run away.
 *   maxSpawnDepth = n  → the tree may grow n spawn-hops deep before the tools stop.
 *
 * The human/scheduled ROOT (depth 0) is NOT gated here — it keeps today's
 * instance-flag gating (`selfMcpEnabled`/`selfMcpWriteEnabled`) on the socket path.
 * The gate only governs the server-initiated (`startAgentTurn`) path.
 *
 * ── Why `<=` and not `<` ─────────────────────────────────────────────────────
 * The gate is evaluated at the CHILD, using the child's OWN depth `d` (that's the
 * depth `startAgentTurn` knows). "A depth-`d` child may act" with `d <= maxSpawnDepth`
 * is the same bound as the equivalent parent-side phrasing "a depth-`(d-1)` parent
 * may spawn" with `(d-1) < maxSpawnDepth`, since a child's depth is always its
 * parent's depth + 1. We evaluate it at the child, so the comparison is `<=`.
 * With the default `1`, a depth-1 child satisfies `1 <= 1` and gets the tools;
 * its depth-2 grandchild fails `2 <= 1` and does not — the bound descends because
 * every child stamped by a tool-equipped parent is one hop deeper.
 *
 * ── Config (DD-5, the `driveMode` pattern) ───────────────────────────────────
 * `maxSpawnDepth` is an instance default (`PADDOCK_MAX_SPAWN_DEPTH`, YAML later
 * per #270) with a per-project override (`project.yaml` → Settings). An absent /
 * invalid override inherits the instance default, resolved at dispatch by
 * {@link resolveMaxSpawnDepth} — never baked into the DTO (mirrors how `driveMode`
 * resolves against `cfg.keeperDriveMode`).
 */

/**
 * Default max spawn depth (Ed, DD-3 decision 2): `1`. A manager's direct children
 * get the self-MCP write tools (report-back + spawn), grandchildren do not.
 */
export const DEFAULT_MAX_SPAWN_DEPTH = 1;

/**
 * Hard upper bound on `maxSpawnDepth` (guards the UI slider + PATCH validation +
 * config loader). Deep trees are deliberately allowed but not unboundedly — a
 * runaway config can't ask for a thousand-deep fan-out. 8 hops is far past any
 * real manager pattern.
 */
export const MAX_SPAWN_DEPTH_LIMIT = 8;

/**
 * Whether `n` is a valid `maxSpawnDepth`: a non-negative integer within bounds.
 * `0` is valid (it disables spawned self-MCP entirely — today's behaviour).
 */
export function isValidMaxSpawnDepth(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= 0 &&
    n <= MAX_SPAWN_DEPTH_LIMIT
  );
}

/**
 * Resolve the effective `maxSpawnDepth` for a dispatch: a valid per-project
 * override wins; otherwise inherit the instance default. Mirrors how `driveMode`
 * resolves (`project.driveMode ?? cfg.keeperDriveMode`) — the override is carried
 * on disk only when set, so an absent value transparently inherits the instance
 * (and, later, a YAML file) default. A malformed override is ignored rather than
 * fatal (defensive: a hand-edited `project.yaml` can't wedge dispatch).
 */
export function resolveMaxSpawnDepth(
  override: number | undefined,
  instanceDefault: number,
): number {
  if (isValidMaxSpawnDepth(override)) return override;
  return isValidMaxSpawnDepth(instanceDefault) ? instanceDefault : DEFAULT_MAX_SPAWN_DEPTH;
}

/**
 * The core gate: does a spawned/scheduled turn running in a chat at `depth`
 * receive the self-MCP? `depth <= maxSpawnDepth` (see the module header for why
 * `<=`). Both operands are read defensively so a corrupt marker can't throw at the
 * dispatch hot path — a negative/NaN depth is treated as never-injectable.
 */
export function spawnedTurnGetsSelfMcp(depth: number, maxSpawnDepth: number): boolean {
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0) return false;
  if (typeof maxSpawnDepth !== "number" || !Number.isFinite(maxSpawnDepth)) return false;
  return depth <= maxSpawnDepth;
}

/** The full injection decision for a server-initiated (spawned) turn. */
export interface SpawnedSelfMcpDecision {
  /** Inject the self-MCP at all (read tools, and — if {@link includeWrite} — write). */
  inject: boolean;
  /** Include the WRITE tools (create/fork/`send_message`) so the child can report back. */
  includeWrite: boolean;
}

/**
 * The COMPLETE gate for whether a spawned/scheduled turn is handed the self-MCP,
 * factored out so the exact rule is unit-tested rather than buried in ws.ts.
 * A spawned turn gets the self-MCP iff it's a keeper (never scratch), the instance
 * opted in (`selfMcpEnabled`), AND its depth is within the bound
 * ({@link spawnedTurnGetsSelfMcp}). The WRITE tools are further gated by the
 * instance write opt-in — in practice always on when a spawn is reachable (a spawn
 * only happens because a parent already had the write tools), but honoured so an
 * operator who disabled writes gets read-only spawned children too.
 */
export function spawnedSelfMcpDecision(params: {
  isScratch: boolean;
  selfMcpEnabled: boolean;
  selfMcpWriteEnabled: boolean;
  depth: number;
  maxSpawnDepth: number;
}): SpawnedSelfMcpDecision {
  const inject =
    !params.isScratch &&
    params.selfMcpEnabled &&
    spawnedTurnGetsSelfMcp(params.depth, params.maxSpawnDepth);
  return { inject, includeWrite: inject && params.selfMcpWriteEnabled };
}
