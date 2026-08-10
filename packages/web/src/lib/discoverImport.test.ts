import { describe, it, expect, vi } from "vitest";
import {
  describeOutcome,
  describeSkips,
  importCandidate,
  outcomeTone,
  runImport,
  type ImportDeps,
} from "./discoverImport";
import type { DiscoverCandidate, Project } from "./types";
import { makeProject } from "../test/factories";

function candidate(over: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    path: "/home/ed/code/paddock",
    name: "paddock",
    suggestedSlug: "paddock",
    hasGit: true,
    insideHome: true,
    sessionCount: 3,
    filteredCount: 0,
    ...over,
  };
}

function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    createProject: vi.fn(async (input) =>
      makeProject({
        slug: input.slug ?? "paddock",
        workingDir: input.path ?? "/home/ed/code/paddock",
      }),
    ) as ImportDeps["createProject"],
    adoptChats: vi.fn(async () => ({ adopted: ["s1", "s2"], skipped: [] })),
    ...over,
  };
}

describe("importCandidate", () => {
  it("creates an UNMANAGED linked project at the candidate's path", async () => {
    // `managed: true` is what gives the sweeper leave to rewrite the CLAUDE.md of
    // somebody's checkout. Discovery only ever proposes directories the user
    // already works in, so it must be explicit rather than derived-and-hoped.
    const d = deps();
    await importCandidate(d, candidate(), {});
    expect(d.createProject).toHaveBeenCalledWith({
      name: "paddock",
      slug: "paddock",
      path: "/home/ed/code/paddock",
      managed: false,
    });
  });

  it("adopts from the CREATED project's workingDir, not the candidate path", async () => {
    // The server canonicalises a linked path when it stores it, and adopt-chats
    // matches on exactly that stored string. Echoing the server's own answer back
    // is the one spelling that cannot drift.
    const created: Project = makeProject({ slug: "paddock", workingDir: "/canonical/paddock" });
    const d = deps({ createProject: vi.fn(async () => created) });
    await importCandidate(d, candidate(), { sessionIds: ["a"] });
    expect(d.adoptChats).toHaveBeenCalledWith("paddock", {
      sourceCwd: "/canonical/paddock",
      sessionIds: ["a"],
    });
  });

  it("omits sessionIds entirely when the plan carries none", async () => {
    const d = deps();
    await importCandidate(d, candidate(), {});
    expect(d.adoptChats).toHaveBeenCalledWith("paddock", {
      sourceCwd: "/home/ed/code/paddock",
    });
  });

  it("reports a create failure without attempting the import", async () => {
    const d = deps({
      createProject: vi.fn(async () => {
        throw new Error("path is already a project");
      }),
    });
    const outcome = await importCandidate(d, candidate(), {});
    expect(outcome.stage).toBe("create");
    expect(outcome.project).toBeUndefined();
    expect(d.adoptChats).not.toHaveBeenCalled();
    expect(outcomeTone(outcome)).toBe("danger");
  });

  it("keeps the created project on the outcome when the IMPORT fails", async () => {
    // The whole reason failures are per row: this leaves a real, empty project
    // behind, and only the row knows that.
    const d = deps({
      adoptChats: vi.fn(async () => {
        throw new Error("engine unavailable");
      }),
    });
    const outcome = await importCandidate(d, candidate(), {});
    expect(outcome.stage).toBe("import");
    expect(outcome.project?.slug).toBe("paddock");
    expect(describeOutcome(outcome, candidate())).toContain("was created, but importing");
    expect(describeOutcome(outcome, candidate())).toContain("there and empty");
  });
});

describe("outcomeTone", () => {
  it("is neither green nor red for a project created with nothing in it", () => {
    // Green would hide an empty project; red would claim a failure that did not
    // happen. It is the third case, and it needs its own colour.
    const outcome = { project: makeProject(), adopted: 0, skipped: [] };
    expect(outcomeTone(outcome)).toBe("warn");
    expect(outcomeTone({ ...outcome, adopted: 2 })).toBe("success");
  });

  it("colours a failed import amber and a failed create red", () => {
    expect(outcomeTone({ stage: "import", adopted: 0, skipped: [], error: "x" })).toBe("warn");
    expect(outcomeTone({ stage: "create", adopted: 0, skipped: [], error: "x" })).toBe("danger");
  });
});

describe("describeOutcome", () => {
  it("diagnoses the divergent recorded path when nothing came in", () => {
    // The trap `recordedPath` exists to catch: a healthy-looking count and an
    // import that matches on exact path equality.
    const c = candidate({ recordedPath: "/private/home/ed/code/paddock" });
    const text = describeOutcome({ project: makeProject(), adopted: 0, skipped: [] }, c);
    expect(text).toContain("/private/home/ed/code/paddock");
    expect(text).toContain("different spelling");
  });

  it("names the skip reasons in English when some were passed over", () => {
    const text = describeOutcome(
      {
        project: makeProject({ slug: "paddock" }),
        adopted: 3,
        skipped: [
          { sessionId: "a", reason: "already-adopted" },
          { sessionId: "b", reason: "sidechain" },
        ],
      },
      candidate(),
    );
    expect(text).toContain("Imported 3 chats");
    expect(text).toContain("already imported");
    expect(text).toContain("sub-agent transcript");
  });

  it("passes an unrecognised reason through verbatim", () => {
    // The vocabulary lives in herdctl, so one this list has not caught up with
    // must still reach the user as itself rather than be swallowed.
    expect(describeSkips([{ sessionId: "a", reason: "brand-new-reason" }])).toContain(
      "brand-new-reason",
    );
  });

  it("says the project exists but is empty when zero chats came in", () => {
    const text = describeOutcome({ project: makeProject({ slug: "x" }), adopted: 0, skipped: [] }, candidate());
    expect(text).toContain("no chats came with it");
  });
});

describe("runImport", () => {
  it("runs rows in order and reports each as it lands", async () => {
    const order: string[] = [];
    const d = deps({
      createProject: vi.fn(async (input) => {
        order.push(`create:${input.slug}`);
        return makeProject({ slug: input.slug ?? "x", workingDir: input.path ?? "/x" });
      }) as ImportDeps["createProject"],
      adoptChats: vi.fn(async (slug) => {
        order.push(`adopt:${slug}`);
        return { adopted: ["s"], skipped: [] };
      }),
    });
    const seen: Array<[string, string]> = [];
    const a = candidate({ path: "/a", suggestedSlug: "a" });
    const b = candidate({ path: "/b", suggestedSlug: "b" });
    const outcomes = await runImport(
      d,
      [
        { candidate: a, plan: {} },
        { candidate: b, plan: {} },
      ],
      (path, status) => seen.push([path, status]),
    );
    expect(order).toEqual(["create:a", "adopt:a", "create:b", "adopt:b"]);
    expect(seen).toEqual([
      ["/a", "running"],
      ["/a", "done"],
      ["/b", "running"],
      ["/b", "done"],
    ]);
    expect(outcomes).toHaveLength(2);
  });

  it("does not let one row's failure abandon the rest of the run", async () => {
    let n = 0;
    const d = deps({
      createProject: vi.fn(async (input) => {
        if (n++ === 0) throw new Error("nope");
        return makeProject({ slug: input.slug ?? "b" });
      }) as ImportDeps["createProject"],
    });
    const outcomes = await runImport(
      d,
      [
        { candidate: candidate({ path: "/a", suggestedSlug: "a" }), plan: {} },
        { candidate: candidate({ path: "/b", suggestedSlug: "b" }), plan: {} },
      ],
      () => {},
    );
    expect(outcomes[0].stage).toBe("create");
    expect(outcomes[1].adopted).toBe(2);
  });
});
