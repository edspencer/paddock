import { describe, it, expect } from "vitest";
import {
  mcpToolInfo,
  parsePaddockManage,
  paddockManageSummary,
  type PaddockManage,
} from "./mcpTools";

describe("mcpToolInfo", () => {
  it("passes a non-mcp tool through unchanged", () => {
    expect(mcpToolInfo("Read")).toEqual({
      isMcp: false,
      server: "",
      isPaddock: false,
      display: "Read",
      tool: "Read",
    });
  });

  it("humanizes a paddock_manage tool and flags provenance", () => {
    expect(mcpToolInfo("mcp__paddock_manage__create_chat")).toEqual({
      isMcp: true,
      server: "paddock_manage",
      isPaddock: true,
      display: "Create chat",
      tool: "create_chat",
    });
  });

  it("recognizes the paddock send_file server", () => {
    const info = mcpToolInfo("mcp__paddock__send_file");
    expect(info.isPaddock).toBe(true);
    expect(info.display).toBe("Send file");
  });

  it("marks a third-party mcp tool as mcp but not paddock", () => {
    const info = mcpToolInfo("mcp__playwright__browser_click");
    expect(info.isMcp).toBe(true);
    expect(info.isPaddock).toBe(false);
    expect(info.display).toBe("Browser click");
  });
});

describe("parsePaddockManage", () => {
  it("returns null for a non-paddock_manage tool", () => {
    expect(parsePaddockManage("Read", "{}")).toBeNull();
    expect(parsePaddockManage("mcp__paddock__send_file", "{}")).toBeNull();
  });

  it("returns null for missing or malformed output", () => {
    expect(parsePaddockManage("mcp__paddock_manage__list_chats", undefined)).toBeNull();
    expect(parsePaddockManage("mcp__paddock_manage__list_chats", "not json")).toBeNull();
    // Wrong shape (no chats array) → null so the caller shows the generic body.
    expect(parsePaddockManage("mcp__paddock_manage__list_chats", "{}")).toBeNull();
  });

  it("parses list_projects", () => {
    const out = JSON.stringify({
      count: 2,
      projects: [
        { slug: "paddock", name: "Paddock", area: "dev", status: "active" },
        { slug: "herdctl", name: "herdctl", status: "active" },
      ],
    });
    const pm = parsePaddockManage("mcp__paddock_manage__list_projects", out);
    expect(pm).toMatchObject({ tool: "list_projects", count: 2 });
    expect((pm as Extract<PaddockManage, { tool: "list_projects" }>).projects).toHaveLength(2);
  });

  it("parses list_chats and preserves the running flag", () => {
    const out = JSON.stringify({
      count: 1,
      project: "paddock",
      chats: [{ project: "paddock", sessionId: "abc123def", name: "Fix bug", running: true }],
    });
    const pm = parsePaddockManage("mcp__paddock_manage__list_chats", out) as Extract<
      PaddockManage,
      { tool: "list_chats" }
    >;
    expect(pm.tool).toBe("list_chats");
    expect(pm.project).toBe("paddock");
    expect(pm.chats[0].running).toBe(true);
  });

  it("parses read_chat with total/returned", () => {
    const out = JSON.stringify({
      project: "paddock",
      sessionId: "s1",
      total: 42,
      returned: 2,
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    });
    const pm = parsePaddockManage("mcp__paddock_manage__read_chat", out) as Extract<
      PaddockManage,
      { tool: "read_chat" }
    >;
    expect(pm).toMatchObject({ tool: "read_chat", total: 42, returned: 2 });
    expect(pm.messages).toHaveLength(2);
  });

  it("parses the write acks (create/fork/send)", () => {
    expect(
      parsePaddockManage(
        "mcp__paddock_manage__create_chat",
        JSON.stringify({ created: true, project: "paddock", sessionId: "new-1" }),
      ),
    ).toEqual({ tool: "create_chat", project: "paddock", sessionId: "new-1" });

    expect(
      parsePaddockManage(
        "mcp__paddock_manage__fork_chat",
        JSON.stringify({ forked: true, project: "paddock", sessionId: "child-1", from: "src-9" }),
      ),
    ).toEqual({ tool: "fork_chat", project: "paddock", sessionId: "child-1", from: "src-9" });

    expect(
      parsePaddockManage(
        "mcp__paddock_manage__send_message",
        JSON.stringify({ sent: true, project: "paddock", sessionId: "s2" }),
      ),
    ).toEqual({ tool: "send_message", project: "paddock", sessionId: "s2" });
  });

  it("parses fork_chat_batch with per-fork prompts", () => {
    const out = JSON.stringify({
      count: 3,
      source: "src-1",
      forks: [
        { sessionId: "f1", prompt: "handle item 1" },
        { sessionId: "f2", prompt: "handle item 2" },
        { sessionId: "f3", prompt: "handle item 3" },
      ],
    });
    const pm = parsePaddockManage("mcp__paddock_manage__fork_chat_batch", out) as Extract<
      PaddockManage,
      { tool: "fork_chat_batch" }
    >;
    expect(pm.tool).toBe("fork_chat_batch");
    expect(pm.count).toBe(3);
    expect(pm.forks[1]).toEqual({ sessionId: "f2", prompt: "handle item 2" });
  });
});

describe("paddockManageSummary", () => {
  it("summarizes each tool for the header", () => {
    expect(
      paddockManageSummary({ tool: "list_projects", count: 3, projects: [] } as PaddockManage),
    ).toBe("3 projects");
    expect(
      paddockManageSummary({
        tool: "list_chats",
        count: 1,
        project: "paddock",
        chats: [],
      } as PaddockManage),
    ).toBe("1 chat in paddock");
    expect(
      paddockManageSummary({
        tool: "list_chats",
        count: 5,
        project: null,
        chats: [],
      } as PaddockManage),
    ).toBe("5 chats across all projects");
    expect(
      paddockManageSummary({
        tool: "fork_chat_batch",
        count: 4,
        source: "s",
        forks: [],
      } as PaddockManage),
    ).toBe("fanned out 4 chats");
  });
});
