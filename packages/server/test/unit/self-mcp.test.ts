/**
 * The Paddock self-management MCP — Phase 1 read-only tools (issue #214). The
 * tools return plain JSON text for the AGENT to read (not a render envelope), so
 * these tests assert the JSON shape for list_projects / list_chats (with and
 * without a project filter) / read_chat, plus read_chat's tail limit + per-message
 * truncation and the required-arg error paths. The handlers are exercised against
 * a fake SelfMcpContext so no fleet is needed.
 */
import { describe, it, expect } from "vitest";
import {
  selfMcpServerDef,
  SELF_MCP_SERVER_KEY,
  SELF_MCP_TOOL_NAMES,
  clampLimit,
  truncateText,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
  READ_CHAT_MAX_TEXT,
  type SelfMcpContext,
  type SelfMcpChat,
  type SelfMcpMessage,
  type SelfMcpProject,
} from "../../src/self-mcp.js";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

function toolByName(context: SelfMcpContext, name: string) {
  const def = selfMcpServerDef(context);
  const tool = def.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

async function call(
  context: SelfMcpContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result: Result; json: any }> {
  const result = (await toolByName(context, name).handler(args)) as Result;
  let json: any = null;
  if (!result.isError) {
    json = JSON.parse(result.content[0].text);
  }
  return { result, json };
}

const PROJECTS: SelfMcpProject[] = [
  { slug: "paddock", name: "Paddock", area: "Homelab", status: "active" },
  { slug: "herdctl", name: "herdctl", area: "Homelab", status: "active" },
];

const CHATS: SelfMcpChat[] = [
  { project: "paddock", sessionId: "aaa", name: "Chat A", updatedAt: "2026-07-14T00:00:00Z", running: true },
  { project: "herdctl", sessionId: "bbb", name: "Chat B", updatedAt: "2026-07-13T00:00:00Z", running: false },
];

function fakeContext(over: Partial<SelfMcpContext> = {}): SelfMcpContext {
  return {
    listProjects: async () => PROJECTS,
    listChats: async (slug) => (slug ? CHATS.filter((c) => c.project === slug) : CHATS),
    readChat: async () => [],
    ...over,
  };
}

describe("self-management MCP (Phase 1, read-only)", () => {
  it("names the server + tools as mcp__paddock_manage__*", () => {
    expect(SELF_MCP_SERVER_KEY).toBe("paddock_manage");
    expect(SELF_MCP_TOOL_NAMES.listProjects).toBe("mcp__paddock_manage__list_projects");
    expect(SELF_MCP_TOOL_NAMES.listChats).toBe("mcp__paddock_manage__list_chats");
    expect(SELF_MCP_TOOL_NAMES.readChat).toBe("mcp__paddock_manage__read_chat");
    const def = selfMcpServerDef(fakeContext());
    expect(def.name).toBe("paddock_manage");
    expect(def.tools.map((t) => t.name).sort()).toEqual(["list_chats", "list_projects", "read_chat"]);
  });

  it("list_projects returns all projects with a count", async () => {
    const { json } = await call(fakeContext(), "list_projects");
    expect(json.count).toBe(2);
    expect(json.projects.map((p: SelfMcpProject) => p.slug)).toEqual(["paddock", "herdctl"]);
  });

  it("list_chats without a project lists chats across ALL projects (cross-project)", async () => {
    const { json } = await call(fakeContext(), "list_chats");
    expect(json.count).toBe(2);
    expect(json.project).toBeNull();
    expect(json.chats.map((c: SelfMcpChat) => c.project)).toEqual(["paddock", "herdctl"]);
    expect(json.chats[0].running).toBe(true);
  });

  it("list_chats with a project filters to that project", async () => {
    const { json } = await call(fakeContext(), "list_chats", { project: "herdctl" });
    expect(json.count).toBe(1);
    expect(json.project).toBe("herdctl");
    expect(json.chats[0].sessionId).toBe("bbb");
  });

  it("read_chat returns the trimmed tail with total/returned counts", async () => {
    const messages: SelfMcpMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `message ${i}`,
      timestamp: `2026-07-14T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    const { json } = await call(fakeContext({ readChat: async () => messages }), "read_chat", {
      project: "paddock",
      session_id: "aaa",
      limit: 10,
    });
    expect(json.total).toBe(100);
    expect(json.returned).toBe(10);
    expect(json.messages[0].text).toBe("message 90"); // last 10 only
    expect(json.messages[9].text).toBe("message 99");
  });

  it("read_chat defaults the limit when omitted and truncates long messages", async () => {
    const huge = "x".repeat(READ_CHAT_MAX_TEXT + 500);
    const messages: SelfMcpMessage[] = Array.from({ length: READ_CHAT_DEFAULT_LIMIT + 5 }, () => ({
      role: "assistant",
      text: huge,
      timestamp: "2026-07-14T00:00:00Z",
    }));
    const { json } = await call(fakeContext({ readChat: async () => messages }), "read_chat", {
      project: "paddock",
      session_id: "aaa",
    });
    expect(json.returned).toBe(READ_CHAT_DEFAULT_LIMIT);
    expect(json.messages[0].text.length).toBeLessThan(huge.length);
    expect(json.messages[0].text).toContain("[truncated 500 chars]");
  });

  it("read_chat errors (isError) when required args are missing", async () => {
    const noProject = await call(fakeContext(), "read_chat", { session_id: "aaa" });
    expect(noProject.result.isError).toBe(true);
    const noSession = await call(fakeContext(), "read_chat", { project: "paddock" });
    expect(noSession.result.isError).toBe(true);
  });

  it("surfaces a store error as an isError result rather than throwing", async () => {
    const boom = fakeContext({
      listProjects: async () => {
        throw new Error("disk gone");
      },
    });
    const { result } = await call(boom, "list_projects");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("disk gone");
  });

  it("clampLimit and truncateText behave at the boundaries", () => {
    expect(clampLimit(undefined)).toBe(READ_CHAT_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(READ_CHAT_MAX_LIMIT);
    expect(clampLimit(15)).toBe(15);
    expect(truncateText("short")).toBe("short");
    expect(truncateText("y".repeat(READ_CHAT_MAX_TEXT + 1))).toContain("[truncated 1 chars]");
  });
});
