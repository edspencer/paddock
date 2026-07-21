import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  attachmentRefsKey,
  readAttachmentRefs,
  writeAttachmentRefs,
  clearAttachmentRefs,
} from "./attachmentRefs";
import type { AttachmentRef } from "./types";

beforeEach(() => localStorage.clear());

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "att-1",
  filename: "shot.png",
  kind: "image",
  ...over,
});

describe("attachment-ref persistence (#346)", () => {
  it("keys an established chat by its session id", () => {
    expect(attachmentRefsKey("sess-1", "proj")).toBe("paddock:attachments:sess-1");
  });

  it("keys a brand-new chat (no session id) by new:<slug>", () => {
    expect(attachmentRefsKey(null, "proj")).toBe("paddock:attachments:new:proj");
    expect(attachmentRefsKey(undefined, "scratch")).toBe("paddock:attachments:new:scratch");
  });

  it("round-trips saved refs", () => {
    const refs = [ref(), ref({ id: "att-2", filename: "notes.md", kind: "markdown", size: 42 })];
    writeAttachmentRefs("sess-1", "proj", refs);
    expect(readAttachmentRefs("sess-1", "proj")).toEqual(refs);
  });

  it("returns an empty array when nothing is stored", () => {
    expect(readAttachmentRefs("missing", "proj")).toEqual([]);
  });

  it("writing an empty list forgets the key (clear-on-send)", () => {
    writeAttachmentRefs("sess-1", "proj", [ref()]);
    writeAttachmentRefs("sess-1", "proj", []);
    expect(readAttachmentRefs("sess-1", "proj")).toEqual([]);
    expect(localStorage.getItem("paddock:attachments:sess-1")).toBeNull();
  });

  it("clearAttachmentRefs removes saved refs", () => {
    writeAttachmentRefs(null, "proj", [ref()]);
    clearAttachmentRefs(null, "proj");
    expect(readAttachmentRefs(null, "proj")).toEqual([]);
  });

  it("new-chat and established-chat refs are independent", () => {
    writeAttachmentRefs(null, "proj", [ref({ id: "new-att" })]);
    writeAttachmentRefs("sess-1", "proj", [ref({ id: "est-att" })]);
    expect(readAttachmentRefs(null, "proj").map((r) => r.id)).toEqual(["new-att"]);
    expect(readAttachmentRefs("sess-1", "proj").map((r) => r.id)).toEqual(["est-att"]);
  });

  it("preserves an optional size and omits it when absent", () => {
    writeAttachmentRefs("sess-1", "proj", [ref({ size: 1234 }), ref({ id: "att-2" })]);
    const got = readAttachmentRefs("sess-1", "proj");
    expect(got[0].size).toBe(1234);
    expect(got[1].size).toBeUndefined();
  });
});

describe("attachment-ref resilience (malformed / private mode / quota)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns [] for non-JSON stored data", () => {
    localStorage.setItem("paddock:attachments:sess-1", "not json{");
    expect(readAttachmentRefs("sess-1", "proj")).toEqual([]);
  });

  it("returns [] when the stored value is not an array", () => {
    localStorage.setItem("paddock:attachments:sess-1", JSON.stringify({ id: "x" }));
    expect(readAttachmentRefs("sess-1", "proj")).toEqual([]);
  });

  it("drops structurally-invalid entries but keeps valid ones", () => {
    localStorage.setItem(
      "paddock:attachments:sess-1",
      JSON.stringify([
        ref(),
        { id: "", filename: "empty-id.png", kind: "image" },
        { filename: "no-id.png", kind: "image" },
        { id: "no-name" },
        "garbage",
        null,
        ref({ id: "att-2", filename: "ok.txt", kind: "text" }),
      ]),
    );
    expect(readAttachmentRefs("sess-1", "proj").map((r) => r.id)).toEqual(["att-1", "att-2"]);
  });

  it("defaults a missing/invalid kind to 'file'", () => {
    localStorage.setItem(
      "paddock:attachments:sess-1",
      JSON.stringify([{ id: "att-1", filename: "mystery" }]),
    );
    expect(readAttachmentRefs("sess-1", "proj")[0].kind).toBe("file");
  });

  it("read never throws when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readAttachmentRefs("sess-1", "proj")).toEqual([]);
  });

  it("write swallows a throwing setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeAttachmentRefs("sess-1", "proj", [ref()])).not.toThrow();
  });

  it("write swallows a throwing removeItem", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => writeAttachmentRefs("sess-1", "proj", [])).not.toThrow();
  });
});
