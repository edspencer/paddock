import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readForkParent, writeForkParent } from "./forkLineage";

beforeEach(() => localStorage.clear());

describe("fork lineage persistence", () => {
  it("round-trips a child's parent lineage", () => {
    writeForkParent("child-1", { sessionId: "parent-1", name: "bug fixes" });
    expect(readForkParent("child-1")).toEqual({ sessionId: "parent-1", name: "bug fixes" });
  });

  it("returns null when the chat has no recorded fork parent", () => {
    expect(readForkParent("unknown")).toBeNull();
  });

  it("returns null for a null/undefined session id", () => {
    expect(readForkParent(null)).toBeNull();
    expect(readForkParent(undefined)).toBeNull();
  });

  it("returns null for a malformed stored value", () => {
    localStorage.setItem("paddock:fork:child-x", "not json");
    expect(readForkParent("child-x")).toBeNull();
    localStorage.setItem("paddock:fork:child-y", JSON.stringify({ sessionId: 3 }));
    expect(readForkParent("child-y")).toBeNull();
  });

  it("keeps lineage independent per child", () => {
    writeForkParent("c1", { sessionId: "p1", name: "one" });
    writeForkParent("c2", { sessionId: "p2", name: "two" });
    expect(readForkParent("c1")?.name).toBe("one");
    expect(readForkParent("c2")?.name).toBe("two");
  });
});

describe("fork lineage resilience (private mode / quota)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("read never throws when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readForkParent("child-1")).toBeNull();
  });

  it("write swallows a throwing setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeForkParent("c", { sessionId: "p", name: "n" })).not.toThrow();
  });
});
