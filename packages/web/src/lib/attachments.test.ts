import { describe, it, expect } from "vitest";
import {
  parseAttachments,
  formatFileSize,
  isTypeAllowed,
  acceptAttribute,
  inferAttachmentKind,
  attachmentRawUrl,
  ATTACHMENTS_OPEN,
  ATTACHMENTS_CLOSE,
} from "./attachments";

/** Mirror the server's wrapper builder for the parse tests. */
function wrap(lines: string[], message: string): string {
  return `${ATTACHMENTS_OPEN}\nheader line\n${lines.join("\n")}\n${ATTACHMENTS_CLOSE}\n\n${message}`;
}

describe("parseAttachments", () => {
  it("returns the content unchanged when there's no wrapper", () => {
    expect(parseAttachments("hello world")).toEqual({ attachments: [], text: "hello world" });
  });

  it("strips the block and parses id/kind/filename", () => {
    const content = wrap(
      [
        "aaaa.png\timage\tshot.png\t/x/aaaa.png",
        "bbbb.csv\ttext\tdata.csv\t/x/bbbb.csv",
      ],
      "please review",
    );
    const { attachments, text } = parseAttachments(content);
    expect(text).toBe("please review");
    expect(attachments).toEqual([
      { id: "aaaa.png", kind: "image", filename: "shot.png" },
      { id: "bbbb.csv", kind: "text", filename: "data.csv" },
    ]);
  });

  it("skips the header line (no tabs) and malformed lines", () => {
    const content = wrap(["short\tline", "ok.png\timage\tpic.png\t/x/ok.png"], "hi");
    const { attachments } = parseAttachments(content);
    expect(attachments).toEqual([{ id: "ok.png", kind: "image", filename: "pic.png" }]);
  });

  it("leaves a preceding preload wrapper intact while stripping its own block", () => {
    const content = `<project-context>\nOVERVIEW\n</project-context>\n\nMy request:\n${wrap(
      ["a.png\timage\ta.png\t/x/a.png"],
      "do it",
    )}`;
    const { attachments, text } = parseAttachments(content);
    expect(attachments.map((a) => a.id)).toEqual(["a.png"]);
    expect(text).toContain("OVERVIEW");
    expect(text).toContain("do it");
    expect(text).not.toContain(ATTACHMENTS_OPEN);
  });
});

describe("formatFileSize", () => {
  it("formats bytes/KB/MB and handles absent/invalid", () => {
    expect(formatFileSize(40)).toBe("40 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("isTypeAllowed (client mirror)", () => {
  it("mirrors the server semantics incl. empty-MIME extension fallback", () => {
    expect(isTypeAllowed(["*"], "anything/here", "x.bin")).toBe(true);
    expect(isTypeAllowed(["image/*"], "image/png", "a.png")).toBe(true);
    expect(isTypeAllowed(["image/*"], "text/plain", "a.txt")).toBe(false);
    expect(isTypeAllowed([".md"], "", "notes.md")).toBe(true);
    expect(isTypeAllowed(["image/*", ".pdf"], "application/pdf", "d.pdf")).toBe(true);
  });
});

describe("acceptAttribute", () => {
  it("yields '' for allow-all and passes patterns/extensions through", () => {
    expect(acceptAttribute(["*"])).toBe("");
    expect(acceptAttribute(["*/*"])).toBe("");
    expect(acceptAttribute(["image/*", ".pdf"])).toBe("image/*,.pdf");
  });
});

describe("inferAttachmentKind / attachmentRawUrl", () => {
  it("infers kinds and builds the raw url", () => {
    expect(inferAttachmentKind("a.png")).toBe("image");
    expect(inferAttachmentKind("a.webm")).toBe("video");
    expect(inferAttachmentKind("a.pdf")).toBe("pdf");
    expect(inferAttachmentKind("a.unknown")).toBe("file");
    expect(attachmentRawUrl("id-1.png")).toBe("/api/chat-files/id-1.png");
  });
});
