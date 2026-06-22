import { describe, it, expect, beforeEach } from "vitest";
import {
  readLastTab,
  writeLastTab,
  clearLastTab,
  toSubPath,
  validateSubPath,
} from "./lastTab";

beforeEach(() => localStorage.clear());

describe("lastTab read/write/clear", () => {
  it("round-trips a valid chat sub-path", () => {
    writeLastTab("p", "chat/sess-1");
    expect(readLastTab("p")).toBe("chat/sess-1");
  });

  it("round-trips a valid files sub-path", () => {
    writeLastTab("p", "files/my-page.html");
    expect(readLastTab("p")).toBe("files/my-page.html");
  });

  it("refuses to persist an invalid shape", () => {
    writeLastTab("p", "../etc/passwd");
    expect(readLastTab("p")).toBeNull();
    writeLastTab("p", "settings");
    expect(readLastTab("p")).toBeNull();
  });

  it("rejects a corrupt stored value on read", () => {
    localStorage.setItem("paddock:lastTab:p", "garbage");
    expect(readLastTab("p")).toBeNull();
  });

  it("accepts bare 'chat' and 'files'", () => {
    writeLastTab("p", "chat");
    expect(readLastTab("p")).toBe("chat");
    writeLastTab("p", "files");
    expect(readLastTab("p")).toBe("files");
  });

  it("clear forgets a project's tab", () => {
    writeLastTab("p", "chat");
    clearLastTab("p");
    expect(readLastTab("p")).toBeNull();
  });
});

describe("toSubPath", () => {
  it("encodes a chat with/without a session id", () => {
    expect(toSubPath({ view: "chat" })).toBe("chat");
    expect(toSubPath({ view: "chat", sessionId: "a/b" })).toBe("chat/a%2Fb");
  });

  it("encodes a files tab with/without a name", () => {
    expect(toSubPath({ view: "files" })).toBe("files");
    expect(toSubPath({ view: "files", name: "my page.html" })).toBe("files/my%20page.html");
  });
});

describe("validateSubPath", () => {
  it("passes through a chat sub-path unchanged", () => {
    expect(validateSubPath("chat/sess", { pinned: [], files: [] })).toBe("chat/sess");
  });

  it("keeps a files/<name> when the file still exists (pinned or listed)", () => {
    expect(validateSubPath("files/a.md", { pinned: ["a.md"], files: [] })).toBe("files/a.md");
    expect(validateSubPath("files/b.md", { pinned: [], files: ["b.md"] })).toBe("files/b.md");
  });

  it("falls back to 'files' when the stored file is gone", () => {
    expect(validateSubPath("files/missing.md", { pinned: ["other"], files: ["x"] })).toBe("files");
  });

  it("decodes the stored name before matching", () => {
    expect(validateSubPath("files/my%20page.html", { pinned: [], files: ["my page.html"] })).toBe(
      "files/my%20page.html",
    );
  });
});
