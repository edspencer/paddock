import { describe, it, expect } from "vitest";
import type { DiscoveredSession } from "@herdctl/core";
import { makeParentResolver, isRecordedRoot } from "../../src/chat-dto.js";
import type { RunProvenance } from "../../src/run-provenance.js";

/**
 * Unit coverage for the chat-list parent edge (#485) and the re-parenting bug it
 * shipped with (#491).
 *
 * The resolver has two tiers — the RECORDED edge stamped at creation, then an
 * INFERENCE from who injected the chat's first message — and tier 2 used to run
 * for any chat lacking tier 1, including chats whose provenance already says
 * they're roots. That made the documented report-back workflow file a human's own
 * manager chat under the child reporting to it.
 */
const session = (sessionId: string): DiscoveredSession =>
  ({ sessionId, workingDirectory: "/w", mtime: "2026-07-27T10:00:00.000Z", resumable: true }) as DiscoveredSession;

/** Stub stores, so the resolver is tested without touching either sidecar. */
function stores(
  provenance: Record<string, RunProvenance>,
  inferred: Record<string, { project: string; sessionId: string; name?: string }>,
) {
  return {
    runProvenance: { get: async (id: string) => provenance[id] },
    messageProvenance: { parentChat: async (id: string) => inferred[id] ?? null },
  };
}

describe("isRecordedRoot (#491)", () => {
  it("treats depth 0 and every root origin as a root", () => {
    expect(isRecordedRoot({ origin: "human", depth: 0 })).toBe(true);
    expect(isRecordedRoot({ origin: "scheduled", depth: 0 })).toBe(true);
    expect(isRecordedRoot({ origin: "hook", depth: 0 })).toBe(true);
    // Origin alone is enough — a human/scheduled/hook chat is never someone's child.
    expect(isRecordedRoot({ origin: "human", depth: 2 })).toBe(true);
  });

  it("does not treat a spawned chat as a root — its edge may need backfilling", () => {
    expect(isRecordedRoot({ origin: "spawned", depth: 1 })).toBe(false);
  });
});

describe("makeParentResolver", () => {
  it("prefers the RECORDED edge over any inference", async () => {
    const { runProvenance, messageProvenance } = stores(
      { child: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" } },
      { child: { project: "paddock", sessionId: "someone-else" } },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("child"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("backfills a spawned chat with no recorded edge from the injected kickoff", async () => {
    const { runProvenance, messageProvenance } = stores(
      { child: { origin: "spawned", depth: 1 } },
      { child: { project: "paddock", sessionId: "mgr", name: "Manager" } },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("child"))).toEqual({
      project: "paddock",
      sessionId: "mgr",
      name: "Manager",
    });
  });

  it("still backfills a chat with NO provenance marker at all (pre-A1 chats)", async () => {
    const { runProvenance, messageProvenance } = stores(
      {},
      { old: { project: "paddock", sessionId: "mgr" } },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("old"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("#491: a human root is NOT re-parented under the child that reports back to it", async () => {
    // The exact shape the docs recommend: manager started by hand (human/depth 0,
    // no recorded parent), child spawned from it, child `send_message`s home. The
    // manager now carries a chat-kind marker naming its own child.
    const { runProvenance, messageProvenance } = stores(
      {
        mgr: { origin: "human", depth: 0 },
        child: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" },
      },
      { mgr: { project: "paddock", sessionId: "child", name: "Child" } },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("mgr"))).toBeNull();
    // ...and the real edge, the other way round, is untouched.
    expect(await parentOf(session("child"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("#491: a scheduled root is not re-parented either", async () => {
    const { runProvenance, messageProvenance } = stores(
      { cron: { origin: "scheduled", depth: 0 } },
      { cron: { project: "paddock", sessionId: "worker" } },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("cron"))).toBeNull();
  });

  it("defaults a cross-project-less inferred parent to this project, and drops self-edges", async () => {
    const { runProvenance, messageProvenance } = stores(
      {},
      {
        a: { project: "", sessionId: "mgr" },
        b: { project: "paddock", sessionId: "b" },
      },
    );
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock");
    expect(await parentOf(session("a"))).toEqual({ project: "paddock", sessionId: "mgr" });
    expect(await parentOf(session("b"))).toBeNull();
  });

  // #508: detach is an OVERRIDE checked ahead of both tiers. The point of the
  // ticket is that it can't be implemented by clearing an edge — most live edges
  // are inferred, so a cleared one is re-derived on the very next list load.
  it("#508: an explicit detach beats the RECORDED edge", async () => {
    const { runProvenance, messageProvenance } = stores(
      { child: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" } },
      {},
    );
    const detached = new Set(["child"]);
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock", async (id) =>
      detached.has(id),
    );
    expect(await parentOf(session("child"))).toBeNull();
  });

  it("#508: an explicit detach beats the INFERRED edge, which would otherwise re-derive", async () => {
    const { runProvenance, messageProvenance } = stores(
      {},
      { old: { project: "paddock", sessionId: "mgr" } },
    );
    const detached = new Set(["old"]);
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock", async (id) =>
      detached.has(id),
    );
    expect(await parentOf(session("old"))).toBeNull();
    // Re-attaching lifts the override and the inferred edge comes straight back.
    detached.delete("old");
    expect(await parentOf(session("old"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("#508: detaching one chat leaves its siblings nested", async () => {
    const { runProvenance, messageProvenance } = stores(
      {
        a: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" },
        b: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" },
      },
      {},
    );
    const parentOf = makeParentResolver(
      runProvenance,
      messageProvenance,
      "paddock",
      async (id) => id === "a",
    );
    expect(await parentOf(session("a"))).toBeNull();
    expect(await parentOf(session("b"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("#508: a throwing detach lookup falls through to the normal tiers", async () => {
    const { runProvenance, messageProvenance } = stores(
      { child: { origin: "spawned", depth: 1, parentSessionId: "mgr", parentProject: "paddock" } },
      {},
    );
    // A broken sidecar must not silently flatten the tree — the recorded edge wins.
    const parentOf = makeParentResolver(runProvenance, messageProvenance, "paddock", async () => {
      throw new Error("boom");
    });
    expect(await parentOf(session("child"))).toEqual({ project: "paddock", sessionId: "mgr" });
  });

  it("survives a throwing store on either tier", async () => {
    const parentOf = makeParentResolver(
      { get: async () => { throw new Error("boom"); } },
      { parentChat: async () => { throw new Error("boom"); } },
      "paddock",
    );
    expect(await parentOf(session("x"))).toBeNull();
  });
});
