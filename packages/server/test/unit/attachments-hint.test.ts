import { describe, it, expect } from "vitest";
import {
  wrapAttachments,
  parseAttachmentsWrapper,
  parseAttachmentIds,
  stripAttachmentsWrapper,
  inferAttachmentKind,
  ATTACHMENTS_OPEN,
  type PromptAttachment,
} from "../../src/attachments-hint.js";
import { wrapPreload } from "../../src/preload.js";

const ATT: PromptAttachment[] = [
  { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png", filename: "shot.png", kind: "image", path: "/data/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png" },
  { id: "11111111-2222-3333-4444-555555555555.csv", filename: "data.csv", kind: "text", path: "/data/attachments/11111111-2222-3333-4444-555555555555.csv" },
];

describe("wrapAttachments", () => {
  it("returns the message unchanged when there are no attachments", () => {
    expect(wrapAttachments([], "hello")).toBe("hello");
  });

  it("prepends a delimited block carrying id/kind/filename/path and the message", () => {
    const wrapped = wrapAttachments(ATT, "please review");
    expect(wrapped.startsWith(ATTACHMENTS_OPEN)).toBe(true);
    // The absolute path is visible so the keeper's Read tool can open it.
    expect(wrapped).toContain("/data/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png");
    expect(wrapped).toContain("Use the Read tool");
    expect(wrapped.endsWith("please review")).toBe(true);
  });

  it("sanitises tabs/newlines out of a filename so the block stays parseable", () => {
    const wrapped = wrapAttachments(
      [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png", filename: "a\tb\nc.png", kind: "image", path: "/x/y.png" }],
      "hi",
    );
    const { attachments } = parseAttachmentsWrapper(wrapped);
    expect(attachments[0].filename).toBe("a b c.png");
  });
});

describe("parseAttachmentsWrapper", () => {
  it("round-trips wrap → parse (refs + clean message)", () => {
    const wrapped = wrapAttachments(ATT, "please review");
    const { attachments, message } = parseAttachmentsWrapper(wrapped);
    expect(message).toBe("please review");
    expect(attachments).toEqual([
      { id: ATT[0].id, filename: "shot.png", kind: "image" },
      { id: ATT[1].id, filename: "data.csv", kind: "text" },
    ]);
  });

  it("returns the input unchanged when there's no wrapper", () => {
    expect(parseAttachmentsWrapper("just a message")).toEqual({
      attachments: [],
      message: "just a message",
    });
  });

  it("recovers the clean request when nested inside a preload wrapper", () => {
    // The real send order: attachments wrap the message, preload wraps the whole.
    const inner = wrapAttachments(ATT, "do the thing");
    const full = wrapPreload("PROJECT OVERVIEW", inner);
    const { attachments, message } = parseAttachmentsWrapper(full);
    expect(attachments.map((a) => a.id)).toEqual([ATT[0].id, ATT[1].id]);
    // The preload block is left intact (existing behavior); only the attachment
    // block is stripped, so the message still contains the preload + request.
    expect(message).toContain("PROJECT OVERVIEW");
    expect(message).toContain("do the thing");
    expect(message).not.toContain(ATTACHMENTS_OPEN);
  });

  it("parseAttachmentIds pulls just the ids (cleanup-on-delete)", () => {
    const wrapped = wrapAttachments(ATT, "x");
    expect(parseAttachmentIds(wrapped)).toEqual([ATT[0].id, ATT[1].id]);
    expect(parseAttachmentIds("no wrapper here")).toEqual([]);
  });

  it("stripAttachmentsWrapper recovers the clean request (chat-name derivation)", () => {
    expect(stripAttachmentsWrapper(wrapAttachments(ATT, "please review"))).toBe("please review");
    expect(stripAttachmentsWrapper("plain message")).toBe("plain message");
  });
});

describe("inferAttachmentKind", () => {
  it("classifies by extension, IMAGE before VIDEO (webp vs webm)", () => {
    expect(inferAttachmentKind("a.png")).toBe("image");
    expect(inferAttachmentKind("a.webp")).toBe("image");
    expect(inferAttachmentKind("a.webm")).toBe("video");
    expect(inferAttachmentKind("a.pdf")).toBe("pdf");
    expect(inferAttachmentKind("a.md")).toBe("markdown");
    expect(inferAttachmentKind("a.ts")).toBe("code");
    expect(inferAttachmentKind("a.csv")).toBe("text");
    expect(inferAttachmentKind("a.bin")).toBe("file");
  });

  it("falls back to the MIME when the extension is unknown", () => {
    expect(inferAttachmentKind("noext", "image/png")).toBe("image");
    expect(inferAttachmentKind("noext", "application/pdf")).toBe("pdf");
  });
});
