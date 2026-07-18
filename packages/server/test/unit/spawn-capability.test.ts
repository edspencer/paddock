/**
 * Spawn-capability gate (issue #262 / B1).
 *
 * The subtle part of B1 is the depth bound that decides whether a SPAWNED turn is
 * handed the self-management MCP (its write tools, so a child can `send_message`
 * back to its parent). These are the pure primitives that encode it; the ws.ts
 * wiring reads them. We assert the exact gate table from the ticket:
 *   - default maxSpawnDepth = 1: depth-1 child → tools, depth-2 grandchild → none;
 *   - maxSpawnDepth = 0 → NO spawned turn gets tools (today's behaviour);
 *   - a per-project override beats the instance default.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SPAWN_DEPTH,
  MAX_SPAWN_DEPTH_LIMIT,
  isValidMaxSpawnDepth,
  resolveMaxSpawnDepth,
  spawnedTurnGetsSelfMcp,
  spawnedSelfMcpDecision,
} from "../../src/spawn-capability.js";

describe("spawn-capability: defaults", () => {
  it("defaults maxSpawnDepth to 1 (manager → children → report-back)", () => {
    expect(DEFAULT_MAX_SPAWN_DEPTH).toBe(1);
  });
});

describe("spawn-capability: spawnedTurnGetsSelfMcp (the gate)", () => {
  it("default (maxSpawnDepth=1): depth-1 child gets tools, depth-2 grandchild does NOT", () => {
    // The manager pattern: a human root (depth 0) spawns a depth-1 child; that
    // child must get the write tools so it can report back AND spawn.
    expect(spawnedTurnGetsSelfMcp(1, DEFAULT_MAX_SPAWN_DEPTH)).toBe(true);
    // …but its depth-2 grandchild must NOT — the fork-bomb bound stops here.
    expect(spawnedTurnGetsSelfMcp(2, DEFAULT_MAX_SPAWN_DEPTH)).toBe(false);
  });

  it("maxSpawnDepth=0 reproduces today's behaviour: NO spawned turn gets tools", () => {
    // Every spawned turn is depth >= 1, so all are gated out at 0.
    expect(spawnedTurnGetsSelfMcp(1, 0)).toBe(false);
    expect(spawnedTurnGetsSelfMcp(2, 0)).toBe(false);
    // A depth-0 root would satisfy it, but roots never reach the spawned path.
    expect(spawnedTurnGetsSelfMcp(0, 0)).toBe(true);
  });

  it("deeper bounds allow deeper trees (inclusive: depth == max still gets tools)", () => {
    expect(spawnedTurnGetsSelfMcp(2, 2)).toBe(true); // depth == max → included
    expect(spawnedTurnGetsSelfMcp(3, 2)).toBe(false); // one past → excluded
    expect(spawnedTurnGetsSelfMcp(3, 5)).toBe(true);
  });

  it("is defensive against a corrupt/negative/NaN depth (never injects)", () => {
    expect(spawnedTurnGetsSelfMcp(-1, 1)).toBe(false);
    expect(spawnedTurnGetsSelfMcp(Number.NaN, 1)).toBe(false);
    expect(spawnedTurnGetsSelfMcp(1, Number.NaN)).toBe(false);
  });
});

describe("spawn-capability: isValidMaxSpawnDepth", () => {
  it("accepts non-negative integers within the limit (0 is valid)", () => {
    expect(isValidMaxSpawnDepth(0)).toBe(true);
    expect(isValidMaxSpawnDepth(1)).toBe(true);
    expect(isValidMaxSpawnDepth(MAX_SPAWN_DEPTH_LIMIT)).toBe(true);
  });

  it("rejects negatives, non-integers, out-of-range, and non-numbers", () => {
    expect(isValidMaxSpawnDepth(-1)).toBe(false);
    expect(isValidMaxSpawnDepth(1.5)).toBe(false);
    expect(isValidMaxSpawnDepth(MAX_SPAWN_DEPTH_LIMIT + 1)).toBe(false);
    expect(isValidMaxSpawnDepth("1")).toBe(false);
    expect(isValidMaxSpawnDepth(undefined)).toBe(false);
    expect(isValidMaxSpawnDepth(null)).toBe(false);
    expect(isValidMaxSpawnDepth(Number.NaN)).toBe(false);
  });
});

describe("spawn-capability: resolveMaxSpawnDepth (per-project override beats default)", () => {
  it("uses a valid per-project override over the instance default", () => {
    expect(resolveMaxSpawnDepth(3, 1)).toBe(3);
    expect(resolveMaxSpawnDepth(0, 1)).toBe(0); // 0 is a real override, not 'absent'
  });

  it("inherits the instance default when there is no override", () => {
    expect(resolveMaxSpawnDepth(undefined, 2)).toBe(2);
  });

  it("ignores an invalid override and inherits the instance default", () => {
    expect(resolveMaxSpawnDepth(-1, 1)).toBe(1);
    expect(resolveMaxSpawnDepth(99, 2)).toBe(2);
    expect(resolveMaxSpawnDepth(1.5, 1)).toBe(1);
  });

  it("falls back to the ticket default when BOTH override and instance default are invalid", () => {
    expect(resolveMaxSpawnDepth(undefined, Number.NaN)).toBe(DEFAULT_MAX_SPAWN_DEPTH);
    expect(resolveMaxSpawnDepth(undefined, -5)).toBe(DEFAULT_MAX_SPAWN_DEPTH);
  });

  it("end-to-end: an override of 0 disables spawned tools even when the instance allows 1", () => {
    const max = resolveMaxSpawnDepth(0, 1);
    expect(spawnedTurnGetsSelfMcp(1, max)).toBe(false);
  });

  it("end-to-end: an override of 2 lets a project spawn deeper than the instance default of 1", () => {
    const max = resolveMaxSpawnDepth(2, 1);
    expect(spawnedTurnGetsSelfMcp(2, max)).toBe(true);
  });
});

describe("spawn-capability: spawnedSelfMcpDecision (full ws.ts gate)", () => {
  // The instance opted fully in (read + write); the depth bound does the gating.
  const ON = { isScratch: false, selfMcpEnabled: true, selfMcpWriteEnabled: true };

  it("default max=1: a depth-1 child is injected WITH write tools (can report back)", () => {
    expect(spawnedSelfMcpDecision({ ...ON, depth: 1, maxSpawnDepth: 1 })).toEqual({
      inject: true,
      includeWrite: true,
    });
  });

  it("default max=1: a depth-2 grandchild gets NOTHING beyond send_file", () => {
    expect(spawnedSelfMcpDecision({ ...ON, depth: 2, maxSpawnDepth: 1 })).toEqual({
      inject: false,
      includeWrite: false,
    });
  });

  it("max=0: no spawned child gets the self-MCP (today's behaviour), even fully opted in", () => {
    expect(spawnedSelfMcpDecision({ ...ON, depth: 1, maxSpawnDepth: 0 })).toEqual({
      inject: false,
      includeWrite: false,
    });
  });

  it("never injects on a scratch turn regardless of depth/flags", () => {
    expect(
      spawnedSelfMcpDecision({ ...ON, isScratch: true, depth: 1, maxSpawnDepth: 5 }).inject,
    ).toBe(false);
  });

  it("respects the instance opt-in: disabled → nothing", () => {
    expect(
      spawnedSelfMcpDecision({ ...ON, selfMcpEnabled: false, depth: 1, maxSpawnDepth: 1 }).inject,
    ).toBe(false);
  });

  it("read-only instance (write off): a within-bound child is injected WITHOUT write tools", () => {
    expect(
      spawnedSelfMcpDecision({
        ...ON,
        selfMcpWriteEnabled: false,
        depth: 1,
        maxSpawnDepth: 1,
      }),
    ).toEqual({ inject: true, includeWrite: false });
  });
});
