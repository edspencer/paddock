import { describe, it, expect } from "vitest";
import { formatDocumentTitle } from "../../lib/documentTitle";
import { makeChat } from "../../test/factories";
import { projectTabScope, projectTitleParts, type ProjectTitleInput } from "./useProjectDocumentTitle";

const base: ProjectTitleInput = {
  view: "home",
  root: false,
  workspaceName: "hushpod",
  activeSession: null,
  activeChat: null,
  pendingChat: null,
  loaded: true,
  filesSubpath: "",
};

/** The full title, with the issue's example brand. */
const title = (over: Partial<ProjectTitleInput>) =>
  formatDocumentTitle({ parts: projectTitleParts({ ...base, ...over }), brand: "House" });

describe("projectTitleParts (#958)", () => {
  it("home: the workspace", () => {
    expect(title({ view: "home" })).toBe("hushpod — House");
  });

  it("chat: the chat's name, then the workspace", () => {
    const chat = makeChat({ sessionId: "s1", name: "Fix the leaking tap" });
    expect(title({ view: "chat", activeSession: "s1", activeChat: chat })).toBe(
      "Fix the leaking tap · hushpod — House",
    );
  });

  it("chat named like its project stays distinct from the project's Home", () => {
    const chat = makeChat({ sessionId: "s1", name: "hushpod" });
    expect(title({ view: "chat", activeSession: "s1", activeChat: chat })).toBe(
      "hushpod · hushpod — House",
    );
  });

  it("the ROOT workspace's name is always omitted (#921's default 'Home' included)", () => {
    const chat = makeChat({ sessionId: "s1", name: "Fix the leaking tap" });
    for (const workspaceName of ["Home", "house", "projects"]) {
      const root = { root: true, workspaceName };
      expect(title({ ...root, view: "home" })).toBe("House");
      expect(title({ ...root, view: "chat", activeSession: "s1", activeChat: chat })).toBe(
        "Fix the leaking tap — House",
      );
      expect(title({ ...root, view: "chat", activeSession: null })).toBe("New chat — House");
      expect(title({ ...root, view: "files" })).toBe("Files — House");
      expect(title({ ...root, view: "settings" })).toBe("Settings — House");
    }
  });

  it("a PROJECT named like the brand keeps its name, so its chats differ from root chats", () => {
    const chat = makeChat({ sessionId: "s1", name: "Fix the leaking tap" });
    expect(
      title({ view: "chat", root: false, workspaceName: "house", activeSession: "s1", activeChat: chat }),
    ).toBe("Fix the leaking tap · house — House");
    expect(title({ view: "home", root: false, workspaceName: "HOUSE" })).toBe("HOUSE — House");
  });

  it("new, unsent chat", () => {
    expect(title({ view: "chat", activeSession: null })).toBe("New chat · hushpod — House");
  });

  it("a just-started chat with no list row yet reads as a new chat", () => {
    expect(title({ view: "chat", activeSession: "s9", pendingChat: "s9" })).toBe(
      "New chat · hushpod — House",
    );
  });

  it("while loading, a deep-linked chat shows the workspace alone — no placeholder", () => {
    expect(title({ view: "chat", activeSession: "s1", loaded: false })).toBe("hushpod — House");
  });

  it("an unknown chat id, once loaded, reads as a generic Chat", () => {
    expect(title({ view: "chat", activeSession: "nope", loaded: true })).toBe(
      "Chat · hushpod — House",
    );
  });

  it("a blank chat name falls back to Chat", () => {
    const chat = makeChat({ sessionId: "s1", name: "   " });
    expect(title({ view: "chat", activeSession: "s1", activeChat: chat })).toBe(
      "Chat · hushpod — House",
    );
  });

  it("a long chat name is truncated to 60 characters", () => {
    const chat = makeChat({ sessionId: "s1", name: "x".repeat(200) });
    expect(title({ view: "chat", activeSession: "s1", activeChat: chat })).toBe(
      `${"x".repeat(59)}… · hushpod — House`,
    );
  });

  it("files list, and an open file by basename", () => {
    expect(title({ view: "files" })).toBe("Files · hushpod — House");
    expect(title({ view: "files", filesSubpath: "src/feed.ts" })).toBe(
      "feed.ts · Files · hushpod — House",
    );
  });

  it("changes, with and without a file", () => {
    expect(title({ view: "changes" })).toBe("Changes · hushpod — House");
    expect(title({ view: "changes", changeFile: "lib/a.ts" })).toBe(
      "a.ts · Changes · hushpod — House",
    );
  });

  it("the remaining tabs", () => {
    expect(title({ view: "history" })).toBe("History · hushpod — House");
    expect(title({ view: "settings" })).toBe("Settings · hushpod — House");
    expect(title({ view: "triggers" })).toBe("Triggers · hushpod — House");
  });
});

describe("projectTabScope (#958 part 3)", () => {
  const scope = (over: Partial<Parameters<typeof projectTabScope>[0]>) =>
    projectTabScope({ view: "home", root: false, slug: "hushpod", activeSession: null, ...over });

  it("a chat page is about its chat; unread only if it is in the unread set", () => {
    expect(scope({ view: "chat", activeSession: "s1" })).toEqual({ kind: "chat", sessionId: "s1", unread: false });
    expect(scope({ view: "chat", activeSession: "s1", unread: new Set(["s1"]) })).toEqual({
      kind: "chat",
      sessionId: "s1",
      unread: true,
    });
  });

  it("a new, unsent chat reports its workspace", () => {
    expect(scope({ view: "chat", activeSession: null })).toEqual({ kind: "workspace", key: "hushpod" });
  });

  it("project tabs report the project; root Home the instance; root's other tabs the root workspace", () => {
    expect(scope({ view: "files" })).toEqual({ kind: "workspace", key: "hushpod" });
    expect(scope({ view: "home", root: true, slug: "" })).toEqual({ kind: "instance" });
    expect(scope({ view: "settings", root: true, slug: "" })).toEqual({ kind: "workspace", key: "" });
  });
});
