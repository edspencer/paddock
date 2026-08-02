/**
 * #509 — `create_chat` must RECORD the chat that created it.
 *
 * The chat tree resolves a parent edge from `RunProvenance.parentSessionId`
 * first and only falls back to inferring one from the kickoff message's sender.
 * `startAgentTurn` used to rebuild the provenance marker from loose
 * `origin`/`depth` scalars, so the parent was dropped on the create_chat path —
 * the dominant way children are made — and every live edge came from inference.
 *
 * These tests pin the WIRING (does createChat hand the parent to the turn?),
 * which is what actually regressed. The stamping itself is covered in
 * run-provenance.test.ts.
 */
import { describe, it, expect } from "vitest";
import { buildManagementOps } from "../../src/management-ops.js";
import { HUMAN_ROOT } from "../../src/run-provenance.js";
import type { ChatHandlerContext } from "../../src/ws-context.js";
import type { StartAgentTurnOpts } from "../../src/ws-context.js";

/**
 * A context stubbed down to just what `createChat` touches. Cast rather than
 * fully built: the turn engine, hub and trigger machinery are irrelevant here
 * and constructing them would bury the one assertion that matters.
 */
function ctxWithRecordedTurn() {
  const turns: StartAgentTurnOpts[] = [];
  const project = {
    slug: "alpha",
    name: "Alpha",
    dir: "/p/alpha",
    workingDir: "/p/alpha",
    model: "claude-opus-5",
  };
  const ctx = {
    deps: {
      projects: { get: async () => project, list: async () => [project] },
      herdctl: {
        listSessions: async () => [
          { sessionId: "parent-session", customName: "Manager", autoName: null },
        ],
        renameSession: async () => undefined,
        ensureAgentModel: async () => undefined,
      },
      cfg: { driveMode: "session", maxSpawnDepth: 1 },
    },
    hub: {},
    startAgentTurn: async (opts: StartAgentTurnOpts) => {
      turns.push(opts);
      return "new-child-session";
    },
    composePreloadedPrompt: async (_slug: string, msg: string) => msg,
    fireTrigger: async () => null,
  } as unknown as ChatHandlerContext;
  return { ctx, turns };
}

const params = (currentSessionId: () => string | null) => ({
  currentProjectSlug: "alpha",
  currentSessionId,
  parentProvenance: HUMAN_ROOT,
  includeWrite: true,
  includeTriggers: false,
  includeProjects: false,
});

describe("#509: create_chat records its parent", () => {
  it("passes the calling chat as the turn's parent ref", async () => {
    const { ctx, turns } = ctxWithRecordedTurn();
    const ops = buildManagementOps(ctx, params(() => "parent-session"));

    await ops.write!.createChat("alpha", "go do a thing", undefined);

    expect(turns).toHaveLength(1);
    expect(turns[0].parent).toEqual({ project: "alpha", sessionId: "parent-session" });
  });

  it("still describes the child as spawned one hop deeper", async () => {
    // The parent edge is additive — it must not disturb the depth bound (#262).
    const { ctx, turns } = ctxWithRecordedTurn();
    const ops = buildManagementOps(ctx, params(() => "parent-session"));

    await ops.write!.createChat("alpha", "go", undefined);

    expect(turns[0].origin).toBe("spawned");
    expect(turns[0].depth).toBe(HUMAN_ROOT.depth + 1);
  });

  it("omits the parent when there is no calling chat", async () => {
    // The external /mcp transport binds currentSessionId to () => null. A parent
    // ref of {project, sessionId: null-ish} would be worse than none: the tree
    // would file the chat under a session that doesn't exist.
    const { ctx, turns } = ctxWithRecordedTurn();
    const ops = buildManagementOps(ctx, params(() => null));

    await ops.write!.createChat("alpha", "go", undefined);

    expect(turns[0].parent).toBeUndefined();
  });

  it("records the parent id without a display name", async () => {
    // Unlike the message SENDER marker, a lineage edge is resolved against the
    // live chat list at render time — a cached name would only go stale.
    const { ctx, turns } = ctxWithRecordedTurn();
    const ops = buildManagementOps(ctx, params(() => "parent-session"));

    await ops.write!.createChat("alpha", "go", undefined);

    expect(turns[0].parent).not.toHaveProperty("name");
  });
});
