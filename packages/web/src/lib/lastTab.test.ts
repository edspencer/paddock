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

  it("round-trips a nested files sub-path (#259)", () => {
    writeLastTab("p", "files/design/plan.md");
    expect(readLastTab("p")).toBe("files/design/plan.md");
  });

  it("refuses to persist an invalid shape", () => {
    writeLastTab("p", "../etc/passwd");
    expect(readLastTab("p")).toBeNull();
    writeLastTab("p", "bogus");
    expect(readLastTab("p")).toBeNull();
  });

  it("rejects a corrupt stored value on read", () => {
    localStorage.setItem("paddock:lastTab:p", "garbage");
    expect(readLastTab("p")).toBeNull();
  });

  it("accepts bare 'home', 'chat', 'files', 'changes' and 'settings'", () => {
    writeLastTab("p", "home");
    expect(readLastTab("p")).toBe("home");
    writeLastTab("p", "chat");
    expect(readLastTab("p")).toBe("chat");
    writeLastTab("p", "files");
    expect(readLastTab("p")).toBe("files");
    writeLastTab("p", "changes");
    expect(readLastTab("p")).toBe("changes");
    writeLastTab("p", "settings");
    expect(readLastTab("p")).toBe("settings");
  });

  it("round-trips a changes sub-path with a file (issue #107)", () => {
    writeLastTab("p", "changes/src%2Fapp.ts");
    expect(readLastTab("p")).toBe("changes/src%2Fapp.ts");
  });

  it("clear forgets a project's tab", () => {
    writeLastTab("p", "chat");
    clearLastTab("p");
    expect(readLastTab("p")).toBeNull();
  });
});

describe("toSubPath", () => {
  it("encodes the home tab", () => {
    expect(toSubPath({ view: "home" })).toBe("home");
  });

  it("encodes a chat with/without a session id", () => {
    expect(toSubPath({ view: "chat" })).toBe("chat");
    expect(toSubPath({ view: "chat", sessionId: "a/b" })).toBe("chat/a%2Fb");
  });

  it("encodes a files tab with/without a path", () => {
    expect(toSubPath({ view: "files" })).toBe("files");
    expect(toSubPath({ view: "files", path: "my page.html" })).toBe("files/my%20page.html");
    // A nested subpath keeps its "/" separators, encoding each segment (#259).
    expect(toSubPath({ view: "files", path: "design/my plan.md" })).toBe(
      "files/design/my%20plan.md",
    );
  });

  it("encodes a changes tab with/without a file (issue #107)", () => {
    expect(toSubPath({ view: "changes" })).toBe("changes");
    expect(toSubPath({ view: "changes", file: "src/app.ts" })).toBe("changes/src%2Fapp.ts");
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

  it("passes a NESTED files subpath through without top-level validation (#259)", () => {
    // A file (or folder) inside a subdirectory can't be checked against the
    // top-level list, so it must survive so the restore lands on it — the Files
    // browser handles a stale one inline. (A single top-level segment is still
    // validated, so a bare top-level dir falls back to the root list.)
    expect(validateSubPath("files/design/plan.md", { pinned: [], files: [] })).toBe(
      "files/design/plan.md",
    );
    expect(validateSubPath("files/design/sub", { pinned: [], files: [] })).toBe(
      "files/design/sub",
    );
  });
});
