import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { draftKey, readDraft, writeDraft, clearDraft } from "./draft";

beforeEach(() => localStorage.clear());

describe("draft persistence", () => {
  it("keys an established chat by its session id", () => {
    expect(draftKey("sess-1", "proj")).toBe("paddock:draft:sess-1");
  });

  it("keys a brand-new chat (no session id) by new:<slug>", () => {
    expect(draftKey(null, "proj")).toBe("paddock:draft:new:proj");
    expect(draftKey(undefined, "scratch")).toBe("paddock:draft:new:scratch");
  });

  it("round-trips a saved draft", () => {
    writeDraft("sess-1", "proj", "half-typed message");
    expect(readDraft("sess-1", "proj")).toBe("half-typed message");
  });

  it("returns an empty string when nothing is stored", () => {
    expect(readDraft("missing", "proj")).toBe("");
  });

  it("writing an empty draft forgets the key (clear-on-send)", () => {
    writeDraft("sess-1", "proj", "typing...");
    writeDraft("sess-1", "proj", "");
    expect(readDraft("sess-1", "proj")).toBe("");
    expect(localStorage.getItem("paddock:draft:sess-1")).toBeNull();
  });

  it("clearDraft removes a saved draft", () => {
    writeDraft(null, "proj", "typing...");
    clearDraft(null, "proj");
    expect(readDraft(null, "proj")).toBe("");
  });

  it("new-chat and established-chat drafts are independent", () => {
    writeDraft(null, "proj", "draft-new");
    writeDraft("sess-1", "proj", "draft-established");
    expect(readDraft(null, "proj")).toBe("draft-new");
    expect(readDraft("sess-1", "proj")).toBe("draft-established");
  });
});

describe("draft resilience (private mode / quota)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("read never throws when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDraft("sess-1", "proj")).toBe("");
  });

  it("write swallows a throwing setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeDraft("sess-1", "proj", "m")).not.toThrow();
  });

  it("write swallows a throwing removeItem", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => writeDraft("sess-1", "proj", "")).not.toThrow();
  });
});
