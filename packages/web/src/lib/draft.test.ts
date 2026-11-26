import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  draftKey,
  readDraft,
  writeDraft,
  clearDraft,
  clearDrafts,
  listDrafts,
  draftPreview,
  draftedChats,
  DRAFTS_CHANGED_EVENT,
} from "./draft";

beforeEach(() => localStorage.clear());

describe("draft persistence", () => {
  it("keys an established chat by its session id", () => {
    expect(draftKey("sess-1", "proj")).toBe("paddock:draft:sess-1");
  });

  it("keys a brand-new chat (no session id) by new:<slug>", () => {
    expect(draftKey(null, "proj")).toBe("paddock:draft:new:proj");
    expect(draftKey(undefined, "proj")).toBe("paddock:draft:new:proj");
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

  it("clearDrafts forgets exactly the listed chats' drafts", () => {
    writeDraft("gone-1", "proj", "a");
    writeDraft("gone-2", "other", "b");
    writeDraft("kept", "proj", "c");
    writeDraft(null, "proj", "d");
    clearDrafts(["gone-1", "gone-2"]);
    expect(readDraft("gone-1", "proj")).toBe("");
    expect(readDraft("gone-2", "other")).toBe("");
    expect(readDraft("kept", "proj")).toBe("c");
    expect(readDraft(null, "proj")).toBe("d");
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

  it("clearDrafts swallows a throwing removeItem", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearDrafts(["sess-1"])).not.toThrow();
  });
});

describe("the same-tab change signal", () => {
  let seen: string[][] = [];
  const onChange = (e: Event) => seen.push((e as CustomEvent<{ ids: string[] }>).detail.ids);
  beforeEach(() => {
    seen = [];
    window.addEventListener(DRAFTS_CHANGED_EVENT, onChange);
  });
  afterEach(() => window.removeEventListener(DRAFTS_CHANGED_EVENT, onChange));

  it("fires with the draft id on each write that changes the stored text", () => {
    writeDraft("sess-1", "proj", "a");
    writeDraft(null, "proj", "b");
    writeDraft("sess-1", "proj", "");
    expect(seen).toEqual([["sess-1"], ["new:proj"], ["sess-1"]]);
  });

  it("stays quiet for a write that changes nothing", () => {
    writeDraft("sess-1", "proj", "a");
    seen = [];
    writeDraft("sess-1", "proj", "a"); // ChatPane's mount-time write of what it restored
    writeDraft("missing", "proj", ""); // nothing stored to remove
    clearDraft("missing", "proj");
    clearDrafts(["missing"]);
    expect(seen).toEqual([]);
  });

  it("fires for clearDraft, and once per clearDrafts with only the ids it removed", () => {
    writeDraft("s1", "proj", "a");
    writeDraft("s2", "proj", "b");
    seen = [];
    clearDraft("s1", "proj");
    writeDraft("s1", "proj", "a");
    seen = [];
    clearDrafts(["s1", "s2", "never-drafted"]);
    expect(seen).toEqual([["s1", "s2"]]);
  });
});

describe("listDrafts", () => {
  it("returns every draft id and its text, and nothing else in storage", () => {
    writeDraft("s1", "proj", "one");
    writeDraft(null, "proj", "two");
    localStorage.setItem("paddock:lastTab:proj", "files");
    expect(listDrafts()).toEqual(
      new Map([
        ["s1", "one"],
        ["new:proj", "two"],
      ]),
    );
  });
});

describe("draftPreview", () => {
  it("collapses whitespace and keeps the opening words", () => {
    expect(draftPreview("  fix   the\nbuild ")).toBe("fix the build");
  });

  it("marks a cut with an ellipsis", () => {
    expect(draftPreview("one two three four five six seven")).toBe("one two three four five six…");
  });

  it("is empty for a whitespace-only draft", () => {
    expect(draftPreview(" \n\t ")).toBe("");
  });
});

describe("draftedChats", () => {
  const chats = new Map([
    ["old", { slug: "a", at: 100 }],
    ["recent", { slug: "b", at: 200 }],
    ["running", { slug: "a", at: Infinity }],
  ]);
  const workspaces = new Set(["a", "b", ""]);

  it("keeps only drafts it can place, most recent activity first, new chats last", () => {
    const drafts = new Map([
      ["new:a", "idea"],
      ["old", "x"],
      ["unknown-session", "orphan"],
      ["new:gone", "orphan"],
      ["recent", "y"],
      ["running", "z"],
    ]);
    expect(draftedChats(drafts, chats, workspaces)).toEqual([
      { id: "running", sessionId: "running", projectSlug: "a", preview: "z" },
      { id: "recent", sessionId: "recent", projectSlug: "b", preview: "y" },
      { id: "old", sessionId: "old", projectSlug: "a", preview: "x" },
      { id: "new:a", sessionId: null, projectSlug: "a", preview: "idea" },
    ]);
  });

  it("places the ROOT workspace's new chat, whose key is the empty string", () => {
    expect(draftedChats(new Map([["new:", "hi"]]), chats, workspaces)).toEqual([
      { id: "new:", sessionId: null, projectSlug: "", preview: "hi" },
    ]);
  });

  it("drops an empty preview", () => {
    expect(draftedChats(new Map([["old", ""]]), chats, workspaces)).toEqual([]);
  });
});
