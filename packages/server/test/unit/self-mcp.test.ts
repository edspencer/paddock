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
  SELF_MCP_HOOK_TOOL_NAMES,
  FORK_BATCH_MAX,
  coercePrompts,
  coerceToolList,
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

  it("coercePrompts accepts arrays, JSON strings, and newline lists (CLI array-arg workaround)", () => {
    expect(coercePrompts(["a", " b "])).toEqual(["a", "b"]);
    expect(coercePrompts('["x","y"]')).toEqual(["x", "y"]);
    expect(coercePrompts("one\n two \n\nthree")).toEqual(["one", "two", "three"]);
    expect(coercePrompts("only one")).toEqual(["only one"]);
    expect(coercePrompts("")).toEqual([]);
    expect(coercePrompts(undefined)).toEqual([]);
    expect(coercePrompts(42)).toEqual([]);
    // array with a non-string entry keeps a "" slot so the handler can reject it
    expect(coercePrompts(["ok", 5])).toEqual(["ok", ""]);
  });

  it("fork_chat_batch works when prompts arrives as a newline STRING (transport workaround)", async () => {
    const w = fakeWrite();
    const { json } = await callWrite(w, "fork_chat_batch", {
      prompts: "item one\nitem two\nitem three",
      name_prefix: "Item",
    });
    expect(json.count).toBe(3);
    expect(w.calls.forkChat.map((c) => c.prompt)).toEqual(["item one", "item two", "item three"]);
    expect(w.calls.forkChat.map((c) => c.name)).toEqual(["Item 1", "Item 2", "Item 3"]);
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
    setArchived: Array<{ projectSlug: string; sessionId: string; archived: boolean }>;
    setSchedule: Array<{ projectSlug: string; name: string; schedule: Record<string, unknown> }>;
    removeSchedule: Array<{ projectSlug: string; name: string }>;
    listSchedules: Array<{ projectSlug: string }>;
    setHook: Array<{ projectSlug: string; name: string; hook: Record<string, unknown> }>;
    removeHook: Array<{ projectSlug: string; name: string }>;
    listHooks: Array<{ projectSlug: string }>;
  };
}

function fakeWrite(over: Partial<SelfMcpWriteContext> = {}): RecordingWrite {
  const calls: RecordingWrite["calls"] = {
    createChat: [],
    forkChat: [],
    sendMessage: [],
    setArchived: [],
    setSchedule: [],
    removeSchedule: [],
    listSchedules: [],
    setHook: [],
    removeHook: [],
    listHooks: [],
  };
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
    setArchived: async (projectSlug, sessionId, archived) => {
      calls.setArchived.push({ projectSlug, sessionId, archived });
    },
    scheduleMutationEnabled: true,
    setSchedule: async (projectSlug, name, schedule) => {
      calls.setSchedule.push({ projectSlug, name, schedule });
      return {
        name,
        type: (schedule.type as "cron" | "interval") ?? "interval",
        cron: (schedule.cron as string) ?? null,
        interval: (schedule.interval as string) ?? null,
        prompt: (schedule.prompt as string) ?? null,
        promptFile: (schedule.promptFile as string) ?? null,
        resumeSession: schedule.resume_session === true,
        enabled: schedule.enabled !== false,
        status: "idle",
        lastRunAt: null,
        nextRunAt: null,
        lastError: null,
      };
    },
    removeSchedule: async (projectSlug, name) => {
      calls.removeSchedule.push({ projectSlug, name });
      return true;
    },
    listSchedules: async (projectSlug) => {
      calls.listSchedules.push({ projectSlug });
      return [];
    },
    // G5 hook management: default OFF (per-project opt-in) so the base 12-tool
    // shape is unchanged; a test opts in via `fakeWrite({ hooksMcpEnabled: true })`.
    hooksMcpEnabled: false,
    listHooks: async (projectSlug) => {
      calls.listHooks.push({ projectSlug });
      return [];
    },
    setHook: async (projectSlug, name, hook) => {
      calls.setHook.push({ projectSlug, name, hook });
      return {
        name,
        agentName: `hook-${projectSlug}-${name}`,
        event: (hook.event as string) ?? "onArchive",
        enabled: hook.enabled === true,
        prompt: (hook.prompt as string) ?? null,
        promptFile: (hook.promptFile as string) ?? null,
        allowedTools:
          ((hook.capabilities as Record<string, unknown> | undefined)?.allowedTools as string[]) ?? [],
        deniedTools:
          ((hook.capabilities as Record<string, unknown> | undefined)?.deniedTools as string[]) ?? [],
        permissionMode:
          ((hook.capabilities as Record<string, unknown> | undefined)?.permissionMode as string) ?? null,
        model: ((hook.capabilities as Record<string, unknown> | undefined)?.model as string) ?? null,
        maxTurns: ((hook.capabilities as Record<string, unknown> | undefined)?.maxTurns as number) ?? null,
      };
    },
    removeHook: async (projectSlug, name) => {
      calls.removeHook.push({ projectSlug, name });
      return true;
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
  it("exposes only the 3 read tools WITHOUT a write ctx, and 12 tools WITH one", () => {
    const readOnly = selfMcpServerDef(fakeContext());
    expect(readOnly.tools.map((t) => t.name).sort()).toEqual(["list_chats", "list_projects", "read_chat"]);

    const withWrite = selfMcpServerDef(fakeContext(), fakeWrite());
    expect(withWrite.tools).toHaveLength(12);
    expect(withWrite.tools.map((t) => t.name).sort()).toEqual([
      "archive_chat",
      "create_chat",
      "fork_chat",
      "fork_chat_batch",
      "list_chats",
      "list_projects",
      "list_schedules",
      "read_chat",
      "remove_schedule",
      "send_message",
      "set_schedule",
      "unarchive_chat",
    ]);
  });

  it("names the write tools as mcp__paddock_manage__*", () => {
    expect(SELF_MCP_WRITE_TOOL_NAMES.createChat).toBe("mcp__paddock_manage__create_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.forkChat).toBe("mcp__paddock_manage__fork_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.sendMessage).toBe("mcp__paddock_manage__send_message");
    expect(SELF_MCP_WRITE_TOOL_NAMES.archiveChat).toBe("mcp__paddock_manage__archive_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.unarchiveChat).toBe("mcp__paddock_manage__unarchive_chat");
    expect(SELF_MCP_WRITE_TOOL_NAMES.forkChatBatch).toBe("mcp__paddock_manage__fork_chat_batch");
    expect(SELF_MCP_WRITE_TOOL_NAMES.setSchedule).toBe("mcp__paddock_manage__set_schedule");
    expect(SELF_MCP_WRITE_TOOL_NAMES.removeSchedule).toBe("mcp__paddock_manage__remove_schedule");
    expect(SELF_MCP_WRITE_TOOL_NAMES.listSchedules).toBe("mcp__paddock_manage__list_schedules");
  });

  it("create_chat defaults project to current and passes name/preload through", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "create_chat", {
      prompt: "do the thing",
      name: "Worker",
      preload_context: true,
    });
    // Echoes the name + kickoff prompt so the chat renders with its real title (#253).
    expect(json).toEqual({
      created: true,
      project: "paddock",
      sessionId: "new-1",
      name: "Worker",
      prompt: "do the thing",
    });
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

  it("create_chat description guides a concise 3–5 word title and names both preload files (C2 / #264)", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite());
    const createChat = def.tools.find((t) => t.name === "create_chat");
    expect(createChat).toBeDefined();

    // (2) short-title guidance in the tool description + the `name` schema.
    expect(createChat!.description).toMatch(/3[–-]5 word/);
    const props = createChat!.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.name.description).toMatch(/3[–-]5 word/);

    // (3) preload description parity: names OVERVIEW.md AND CHANGELOG.md (the
    // behaviour already injects both — the wording was stale).
    expect(createChat!.description).toContain("OVERVIEW.md");
    expect(createChat!.description).toContain("CHANGELOG.md");
    expect(props.preload_context.description).toContain("OVERVIEW.md");
    expect(props.preload_context.description).toContain("CHANGELOG.md");
  });

  it("fork_chat defaults the source to currentSessionId()", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat", { prompt: "explore option A" });
    expect(json).toEqual({
      forked: true,
      project: "paddock",
      sessionId: "fork-1",
      from: "current-sid",
      prompt: "explore option A",
    });
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
    expect(json).toEqual({ sent: true, project: "paddock", sessionId: "bbb", prompt: "ping" });
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

  it("archive_chat defaults the target to the CURRENT chat (archive yourself)", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "archive_chat", {});
    expect(json).toEqual({ archived: true, project: "paddock", sessionId: "current-sid" });
    expect(write.calls.setArchived).toEqual([
      { projectSlug: "paddock", sessionId: "current-sid", archived: true },
    ]);
  });

  it("archive_chat uses an explicit session_id + project when given", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "archive_chat", { session_id: "other-sid", project: "herdctl" });
    expect(json).toEqual({ archived: true, project: "herdctl", sessionId: "other-sid" });
    expect(write.calls.setArchived).toEqual([
      { projectSlug: "herdctl", sessionId: "other-sid", archived: true },
    ]);
  });

  it("unarchive_chat sets archived=false and round-trips the current chat", async () => {
    const write = fakeWrite();
    await callWrite(write, "archive_chat", {});
    const { json } = await callWrite(write, "unarchive_chat", {});
    expect(json).toEqual({ archived: false, project: "paddock", sessionId: "current-sid" });
    expect(write.calls.setArchived).toEqual([
      { projectSlug: "paddock", sessionId: "current-sid", archived: true },
      { projectSlug: "paddock", sessionId: "current-sid", archived: false },
    ]);
  });

  it("archive_chat errors when no current session and no session_id arg", async () => {
    const write = fakeWrite({ currentSessionId: () => null });
    const { result } = await callWrite(write, "archive_chat", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no chat to archive");
    expect(write.calls.setArchived).toHaveLength(0);
  });

  it("surfaces an archive-callback throw as an isError result rather than throwing", async () => {
    const write = fakeWrite({
      setArchived: async () => {
        throw new Error("disk gone");
      },
    });
    const { result } = await callWrite(write, "archive_chat", { session_id: "aaa" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("disk gone");
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

// ── Schedule tools (issue #289) ─────────────────────────────────────────────

describe("self-management MCP (schedule tools)", () => {
  it("set_schedule builds a cron record, defaults project to current, echoes the saved DTO", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "set_schedule", {
      name: "daily-triage",
      type: "cron",
      cron: "0 9 * * *",
      prompt: "Triage new issues",
      resume_session: true,
    });
    expect(write.calls.setSchedule).toEqual([
      {
        projectSlug: "paddock",
        name: "daily-triage",
        schedule: { type: "cron", cron: "0 9 * * *", prompt: "Triage new issues", resume_session: true },
      },
    ]);
    expect(json.set).toBe(true);
    expect(json.project).toBe("paddock");
    expect(json.schedule).toMatchObject({
      name: "daily-triage",
      type: "cron",
      cron: "0 9 * * *",
      prompt: "Triage new issues",
      resumeSession: true,
      enabled: true,
    });
  });

  it("set_schedule builds an interval record with a prompt_file (promptFile sugar)", async () => {
    const write = fakeWrite();
    await callWrite(write, "set_schedule", {
      name: "hourly",
      type: "interval",
      interval: "1h",
      prompt_file: "hourly.md",
      project: "other",
    });
    expect(write.calls.setSchedule).toEqual([
      { projectSlug: "other", name: "hourly", schedule: { type: "interval", interval: "1h", promptFile: "hourly.md" } },
    ]);
  });

  it("set_schedule rejects a missing name / bad type / missing cron / missing prompt", async () => {
    const write = fakeWrite();
    const noName = await callWrite(write, "set_schedule", { type: "cron", cron: "* * * * *", prompt: "x" });
    expect(noName.result.isError).toBe(true);
    expect(noName.result.content[0].text).toContain("`name` is required");

    const badType = await callWrite(write, "set_schedule", { name: "s", type: "weekly", prompt: "x" });
    expect(badType.result.isError).toBe(true);
    expect(badType.result.content[0].text).toContain('`type` must be "cron" or "interval"');

    const noCron = await callWrite(write, "set_schedule", { name: "s", type: "cron", prompt: "x" });
    expect(noCron.result.isError).toBe(true);
    expect(noCron.result.content[0].text).toContain("`cron` is required");

    const noPrompt = await callWrite(write, "set_schedule", { name: "s", type: "interval", interval: "5m" });
    expect(noPrompt.result.isError).toBe(true);
    expect(noPrompt.result.content[0].text).toContain("`prompt`");

    // None of the invalid calls should have reached the callback.
    expect(write.calls.setSchedule).toHaveLength(0);
  });

  it("set_schedule and remove_schedule refuse when the mutation gate is off", async () => {
    const write = fakeWrite({ scheduleMutationEnabled: false });
    const set = await callWrite(write, "set_schedule", { name: "s", type: "interval", interval: "5m", prompt: "x" });
    expect(set.result.isError).toBe(true);
    expect(set.result.content[0].text).toContain("Schedule mutation is disabled");

    const rm = await callWrite(write, "remove_schedule", { name: "s" });
    expect(rm.result.isError).toBe(true);
    expect(rm.result.content[0].text).toContain("Schedule mutation is disabled");

    expect(write.calls.setSchedule).toHaveLength(0);
    expect(write.calls.removeSchedule).toHaveLength(0);
  });

  it("list_schedules works even with the mutation gate off (read-only)", async () => {
    const write = fakeWrite({
      scheduleMutationEnabled: false,
      listSchedules: async () => [
        {
          name: "daily",
          type: "cron",
          cron: "0 9 * * *",
          interval: null,
          prompt: "go",
          promptFile: null,
          resumeSession: false,
          enabled: true,
          status: "idle",
          lastRunAt: null,
          nextRunAt: "2026-07-19T09:00:00Z",
          lastError: null,
        },
      ],
    });
    const { json } = await callWrite(write, "list_schedules", {});
    expect(json).toEqual({
      project: "paddock",
      count: 1,
      schedules: [
        {
          name: "daily",
          type: "cron",
          cron: "0 9 * * *",
          interval: null,
          prompt: "go",
          promptFile: null,
          resumeSession: false,
          enabled: true,
          status: "idle",
          lastRunAt: null,
          nextRunAt: "2026-07-19T09:00:00Z",
          lastError: null,
        },
      ],
    });
  });

  it("remove_schedule defaults project to current and echoes removed", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "remove_schedule", { name: "daily" });
    expect(write.calls.removeSchedule).toEqual([{ projectSlug: "paddock", name: "daily" }]);
    expect(json).toEqual({ removed: true, project: "paddock", name: "daily" });
  });

  it("remove_schedule requires a name", async () => {
    const write = fakeWrite();
    const { result } = await callWrite(write, "remove_schedule", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("`name` is required");
    expect(write.calls.removeSchedule).toHaveLength(0);
  });

  it("surfaces a setSchedule-callback throw as an isError result rather than throwing", async () => {
    const write = fakeWrite({
      setSchedule: async () => {
        throw new Error("Invalid schedule definition");
      },
    });
    const { result } = await callWrite(write, "set_schedule", {
      name: "s",
      type: "interval",
      interval: "5m",
      prompt: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid schedule definition");
  });
});

// ── coerceToolList (Epic G / G5) ────────────────────────────────────────────

describe("coerceToolList", () => {
  it("accepts a real array, dropping non-strings + blanks", () => {
    expect(coerceToolList(["Bash", " Read ", "", 3, "Write"])).toEqual(["Bash", "Read", "Write"]);
  });
  it("parses a JSON array string (CLI transport dropped the array type)", () => {
    expect(coerceToolList('["Bash", "Read"]')).toEqual(["Bash", "Read"]);
  });
  it("splits a comma/newline-separated string", () => {
    expect(coerceToolList("Bash, Read\nWrite")).toEqual(["Bash", "Read", "Write"]);
  });
  it("returns [] for blank/absent/non-string input (a tool-less hook)", () => {
    expect(coerceToolList("")).toEqual([]);
    expect(coerceToolList("   ")).toEqual([]);
    expect(coerceToolList(undefined)).toEqual([]);
    expect(coerceToolList(42)).toEqual([]);
  });
});

// ── Hook-management tools (Epic G / G5, GG-4) ────────────────────────────────

describe("self-management MCP (hook tools + per-project gate)", () => {
  it("hook tools are ABSENT when hooksMcpEnabled is off (the default write ctx)", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite());
    const names = def.tools.map((t) => t.name);
    expect(names).not.toContain("list_hooks");
    expect(names).not.toContain("set_hook");
    expect(names).not.toContain("remove_hook");
  });

  it("appends exactly the 3 hook tools (15 total) when hooksMcpEnabled is on", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite({ hooksMcpEnabled: true }));
    expect(def.tools).toHaveLength(15);
    expect(def.tools.map((t) => t.name).sort()).toEqual([
      "archive_chat",
      "create_chat",
      "fork_chat",
      "fork_chat_batch",
      "list_chats",
      "list_hooks",
      "list_projects",
      "list_schedules",
      "read_chat",
      "remove_hook",
      "remove_schedule",
      "send_message",
      "set_hook",
      "set_schedule",
      "unarchive_chat",
    ]);
  });

  it("hook tools are absent WITHOUT a write ctx even though hooks are a write-block feature", () => {
    const def = selfMcpServerDef(fakeContext());
    expect(def.tools.map((t) => t.name)).not.toContain("set_hook");
  });

  it("names the hook tools as mcp__paddock_manage__*", () => {
    expect(SELF_MCP_HOOK_TOOL_NAMES.listHooks).toBe("mcp__paddock_manage__list_hooks");
    expect(SELF_MCP_HOOK_TOOL_NAMES.setHook).toBe("mcp__paddock_manage__set_hook");
    expect(SELF_MCP_HOOK_TOOL_NAMES.removeHook).toBe("mcp__paddock_manage__remove_hook");
  });

  it("set_hook builds a record with capabilities, defaults project to current, echoes the DTO", async () => {
    const write = fakeWrite({ hooksMcpEnabled: true });
    const { json } = await callWrite(write, "set_hook", {
      name: "cleanup",
      event: "onArchive",
      prompt: "spin down my pm servers",
      allowed_tools: "Bash, Read",
      permission_mode: "acceptEdits",
      max_turns: 12,
      enabled: true,
    });
    expect(write.calls.setHook).toHaveLength(1);
    expect(write.calls.setHook[0]).toEqual({
      projectSlug: "paddock",
      name: "cleanup",
      hook: {
        event: "onArchive",
        prompt: "spin down my pm servers",
        enabled: true,
        capabilities: {
          allowedTools: ["Bash", "Read"],
          permissionMode: "acceptEdits",
          maxTurns: 12,
        },
      },
    });
    expect(json.set).toBe(true);
    expect(json.project).toBe("paddock");
    expect(json.hook.agentName).toBe("hook-paddock-cleanup");
    expect(json.hook.allowedTools).toEqual(["Bash", "Read"]);
    expect(json.hook.enabled).toBe(true);
  });

  it("set_hook supports prompt_file (promptFile sugar) and a target project", async () => {
    const write = fakeWrite({ hooksMcpEnabled: true });
    await callWrite(write, "set_hook", {
      name: "cleanup",
      event: "onArchive",
      prompt_file: "cleanup.md",
      project: "herdctl",
    });
    expect(write.calls.setHook[0].projectSlug).toBe("herdctl");
    expect(write.calls.setHook[0].hook).toEqual({ event: "onArchive", promptFile: "cleanup.md" });
  });

  it("set_hook omits enabled + capabilities when not supplied (a tool-less create)", async () => {
    const write = fakeWrite({ hooksMcpEnabled: true });
    await callWrite(write, "set_hook", { name: "h", event: "onArchive", prompt: "think" });
    expect(write.calls.setHook[0].hook).toEqual({ event: "onArchive", prompt: "think" });
  });

  it("set_hook rejects a missing name / missing event / no prompt or prompt_file", async () => {
    const write = fakeWrite({ hooksMcpEnabled: true });
    const noName = await callWrite(write, "set_hook", { event: "onArchive", prompt: "x" });
    expect(noName.result.isError).toBe(true);
    expect(noName.result.content[0].text).toContain("`name` is required");

    const noEvent = await callWrite(write, "set_hook", { name: "h", prompt: "x" });
    expect(noEvent.result.isError).toBe(true);
    expect(noEvent.result.content[0].text).toContain("`event` is required");

    const noPrompt = await callWrite(write, "set_hook", { name: "h", event: "onArchive" });
    expect(noPrompt.result.isError).toBe(true);
    expect(noPrompt.result.content[0].text).toContain("prompt");
    expect(write.calls.setHook).toHaveLength(0);
  });

  it("list_hooks defaults project to current and returns the hooks", async () => {
    const hooks = [
      {
        name: "cleanup",
        agentName: "hook-paddock-cleanup",
        event: "onArchive",
        enabled: false,
        prompt: "x",
        promptFile: null,
        allowedTools: ["Bash"],
        deniedTools: [],
        permissionMode: null,
        model: null,
        maxTurns: null,
      },
    ];
    const write = fakeWrite({ hooksMcpEnabled: true, listHooks: async () => hooks });
    const { json } = await callWrite(write, "list_hooks", {});
    expect(json).toEqual({ project: "paddock", count: 1, hooks });
  });

  it("remove_hook defaults project to current, echoes removed, and requires a name", async () => {
    const write = fakeWrite({ hooksMcpEnabled: true });
    const { json } = await callWrite(write, "remove_hook", { name: "cleanup" });
    expect(json).toEqual({ removed: true, project: "paddock", name: "cleanup" });
    expect(write.calls.removeHook[0]).toEqual({ projectSlug: "paddock", name: "cleanup" });

    const { result } = await callWrite(write, "remove_hook", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("`name` is required");
  });

  it("surfaces a setHook-callback throw as an isError result rather than throwing", async () => {
    const write = fakeWrite({
      hooksMcpEnabled: true,
      setHook: async () => {
        throw new Error("Invalid hook definition");
      },
    });
    const { result } = await callWrite(write, "set_hook", {
      name: "h",
      event: "onArchive",
      prompt: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid hook definition");
  });
});
