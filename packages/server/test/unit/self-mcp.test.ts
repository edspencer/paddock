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
  SELF_MCP_WRITE_TOOL_NAMES,
  FORK_BATCH_MAX,
  clampLimit,
  truncateText,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
  READ_CHAT_MAX_TEXT,
  type SelfMcpContext,
  type SelfMcpWriteContext,
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

// ── Phase 2: write tools ────────────────────────────────────────────────────

interface RecordingWrite extends SelfMcpWriteContext {
  calls: {
    createChat: Array<{ projectSlug: string; prompt: string; opts?: { name?: string; preloadContext?: boolean } }>;
    forkChat: Array<{ projectSlug: string; sourceSessionId: string; prompt?: string; name?: string }>;
    sendMessage: Array<{ projectSlug: string; sessionId: string; prompt: string }>;
  };
}

function fakeWrite(over: Partial<SelfMcpWriteContext> = {}): RecordingWrite {
  const calls: RecordingWrite["calls"] = { createChat: [], forkChat: [], sendMessage: [] };
  let n = 0;
  const base: SelfMcpWriteContext = {
    currentProjectSlug: "paddock",
    currentSessionId: () => "current-sid",
    createChat: async (projectSlug, prompt, opts) => {
      calls.createChat.push({ projectSlug, prompt, opts });
      return { sessionId: `new-${++n}` };
    },
    forkChat: async (args) => {
      calls.forkChat.push({ ...args });
      return { sessionId: `fork-${++n}` };
    },
    sendMessage: async (projectSlug, sessionId, prompt) => {
      calls.sendMessage.push({ projectSlug, sessionId, prompt });
    },
    ...over,
  };
  return { ...base, calls };
}

function writeToolByName(context: SelfMcpContext, write: SelfMcpWriteContext, name: string) {
  const def = selfMcpServerDef(context, write);
  const tool = def.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

async function callWrite(
  write: SelfMcpWriteContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result: Result; json: any }> {
  const result = (await writeToolByName(fakeContext(), write, name).handler(args)) as Result;
  let json: any = null;
  if (!result.isError) json = JSON.parse(result.content[0].text);
  return { result, json };
}

describe("self-management MCP (Phase 2, write tools)", () => {
  it("exposes only the 3 read tools WITHOUT a write ctx, and 7 tools WITH one", () => {
    const readOnly = selfMcpServerDef(fakeContext());
    expect(readOnly.tools.map((t) => t.name).sort()).toEqual(["list_chats", "list_projects", "read_chat"]);

    const withWrite = selfMcpServerDef(fakeContext(), fakeWrite());
    expect(withWrite.tools).toHaveLength(7);
    expect(withWrite.tools.map((t) => t.name).sort()).toEqual([
      "create_chat",
      "fork_chat",
      "fork_chat_batch",
      "list_chats",
      "list_projects",
      "read_chat",
      "send_message",
    ]);
  });

  it("names the write tools as mcp__paddock_manage__*", () => {
    expect(SELF_MCP_WRITE_TOOL_NAMES.createChat).toBe("mcp__paddock_manage__create_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.forkChat).toBe("mcp__paddock_manage__fork_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.sendMessage).toBe("mcp__paddock_manage__send_message");
    expect(SELF_MCP_WRITE_TOOL_NAMES.forkChatBatch).toBe("mcp__paddock_manage__fork_chat_batch");
  });

  it("create_chat defaults project to current and passes name/preload through", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "create_chat", {
      prompt: "do the thing",
      name: "Worker",
      preload_context: true,
    });
    expect(json).toEqual({ created: true, project: "paddock", sessionId: "new-1" });
    expect(write.calls.createChat).toEqual([
      { projectSlug: "paddock", prompt: "do the thing", opts: { name: "Worker", preloadContext: true } },
    ]);
  });

  it("create_chat honors an explicit project", async () => {
    const write = fakeWrite();
    await callWrite(write, "create_chat", { prompt: "hi", project: "herdctl" });
    expect(write.calls.createChat[0].projectSlug).toBe("herdctl");
  });

  it("create_chat rejects an empty prompt", async () => {
    const write = fakeWrite();
    const { result } = await callWrite(write, "create_chat", { prompt: "   " });
    expect(result.isError).toBe(true);
    expect(write.calls.createChat).toHaveLength(0);
  });

  it("fork_chat defaults the source to currentSessionId()", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat", { prompt: "explore option A" });
    expect(json).toEqual({ forked: true, project: "paddock", sessionId: "fork-1", from: "current-sid" });
    expect(write.calls.forkChat).toEqual([
      { projectSlug: "paddock", sourceSessionId: "current-sid", prompt: "explore option A", name: undefined },
    ]);
  });

  it("fork_chat uses an explicit session_id + project when given", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat", {
      session_id: "other-sid",
      project: "herdctl",
      name: "Branch",
    });
    expect(json.from).toBe("other-sid");
    expect(write.calls.forkChat[0]).toEqual({
      projectSlug: "herdctl",
      sourceSessionId: "other-sid",
      prompt: undefined,
      name: "Branch",
    });
  });

  it("fork_chat errors when no current session and no session_id arg", async () => {
    const write = fakeWrite({ currentSessionId: () => null });
    const { result } = await callWrite(write, "fork_chat", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no chat to fork");
    expect(write.calls.forkChat).toHaveLength(0);
  });

  it("send_message passes through and defaults project to current", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "send_message", { session_id: "bbb", prompt: "ping" });
    expect(json).toEqual({ sent: true, project: "paddock", sessionId: "bbb" });
    expect(write.calls.sendMessage).toEqual([{ projectSlug: "paddock", sessionId: "bbb", prompt: "ping" }]);
  });

  it("send_message requires session_id and prompt", async () => {
    const write = fakeWrite();
    const noSession = await callWrite(write, "send_message", { prompt: "hi" });
    expect(noSession.result.isError).toBe(true);
    const noPrompt = await callWrite(write, "send_message", { session_id: "bbb" });
    expect(noPrompt.result.isError).toBe(true);
    expect(write.calls.sendMessage).toHaveLength(0);
  });

  it("fork_chat_batch forks once per prompt, applies name_prefix, returns count", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat_batch", {
      prompts: ["item 1", "item 2", "item 3"],
      name_prefix: "Item",
    });
    expect(json.count).toBe(3);
    expect(json.source).toBe("current-sid");
    expect(json.forks).toHaveLength(3);
    expect(write.calls.forkChat).toHaveLength(3);
    expect(write.calls.forkChat.map((c) => c.name)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(write.calls.forkChat.map((c) => c.prompt)).toEqual(["item 1", "item 2", "item 3"]);
    expect(write.calls.forkChat.every((c) => c.sourceSessionId === "current-sid")).toBe(true);
  });

  it("fork_chat_batch errors on an empty array", async () => {
    const write = fakeWrite();
    const { result } = await callWrite(write, "fork_chat_batch", { prompts: [] });
    expect(result.isError).toBe(true);
    expect(write.calls.forkChat).toHaveLength(0);
  });

  it("fork_chat_batch errors over FORK_BATCH_MAX", async () => {
    const write = fakeWrite();
    const prompts = Array.from({ length: FORK_BATCH_MAX + 1 }, (_, i) => `p${i}`);
    const { result } = await callWrite(write, "fork_chat_batch", { prompts });
    expect(result.isError).toBe(true);
    expect(write.calls.forkChat).toHaveLength(0);
  });

  it("fork_chat_batch errors on a non-string/empty entry", async () => {
    const write = fakeWrite();
    const bad = await callWrite(write, "fork_chat_batch", { prompts: ["ok", 42] });
    expect(bad.result.isError).toBe(true);
    const blank = await callWrite(write, "fork_chat_batch", { prompts: ["ok", "  "] });
    expect(blank.result.isError).toBe(true);
    expect(write.calls.forkChat).toHaveLength(0);
  });

  it("fork_chat_batch errors when no current session and no session_id arg", async () => {
    const write = fakeWrite({ currentSessionId: () => null });
    const { result } = await callWrite(write, "fork_chat_batch", { prompts: ["a"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no chat to fork");
  });

  it("surfaces a write-callback throw as an isError result rather than throwing", async () => {
    const write = fakeWrite({
      createChat: async () => {
        throw new Error("fleet exploded");
      },
    });
    const { result } = await callWrite(write, "create_chat", { prompt: "go" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fleet exploded");
  });
});
