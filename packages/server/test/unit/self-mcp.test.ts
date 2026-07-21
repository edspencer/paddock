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
  SELF_MCP_TRIGGER_TOOL_NAMES,
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
    setTrigger: Array<{ projectSlug: string; name: string; trigger: Record<string, unknown> }>;
    removeTrigger: Array<{ projectSlug: string; name: string }>;
    listTriggers: Array<{ projectSlug: string }>;
    runTrigger: Array<{ projectSlug: string; name: string }>;
  };
}

function fakeWrite(over: Partial<SelfMcpWriteContext> = {}): RecordingWrite {
  const calls: RecordingWrite["calls"] = {
    createChat: [],
    forkChat: [],
    sendMessage: [],
    setArchived: [],
    setTrigger: [],
    removeTrigger: [],
    listTriggers: [],
    runTrigger: [],
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
    // T3 unified trigger management: default OFF (per-project opt-in) so the base
    // 9-tool shape is unchanged; a test opts in via `fakeWrite({ triggersMcpEnabled: true })`.
    triggersMcpEnabled: false,
    setTrigger: async (projectSlug, name, trigger) => {
      calls.setTrigger.push({ projectSlug, name, trigger });
      // Echo the incoming partial `{ trigger?, run?, enabled? }` onto a flat
      // SelfMcpTrigger (the real ws.ts callback merges over the existing record;
      // this fake just projects what the handler supplied so tests can assert it).
      const when = (trigger.trigger as Record<string, unknown> | undefined) ?? {};
      const run = (trigger.run as Record<string, unknown> | undefined) ?? {};
      const type = (when.type as "schedule" | "event" | "webhook") ?? "event";
      return {
        name,
        agentName: `trigger-${projectSlug}-${name}`,
        type,
        cron: (when.cron as string) ?? null,
        interval: (when.interval as string) ?? null,
        event: (when.on as string) ?? null,
        path: (when.path as string) ?? null,
        prompt: (run.prompt as string) ?? null,
        promptFile: (run.promptFile as string) ?? null,
        session: (run.session as "new" | "resume") ?? "new",
        tools: (run.tools as string[]) ?? [],
        maxSpawnDepth: (run.maxSpawnDepth as number) ?? null,
        permissionMode: (run.permissionMode as string) ?? null,
        model: (run.model as string) ?? null,
        maxTurns: (run.maxTurns as number) ?? null,
        enabled: trigger.enabled === true,
        status: type === "schedule" ? "idle" : null,
        lastRunAt: null,
        nextRunAt: null,
        lastError: null,
      };
    },
    removeTrigger: async (projectSlug, name) => {
      calls.removeTrigger.push({ projectSlug, name });
      return true;
    },
    listTriggers: async (projectSlug) => {
      calls.listTriggers.push({ projectSlug });
      return [];
    },
    runTrigger: async (projectSlug, name) => {
      calls.runTrigger.push({ projectSlug, name });
      return `ran-${++n}`;
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
  it("exposes only the 3 read tools WITHOUT a write ctx, and 9 tools WITH one (triggers gated OFF)", () => {
    const readOnly = selfMcpServerDef(fakeContext());
    expect(readOnly.tools.map((t) => t.name).sort()).toEqual(["list_chats", "list_projects", "read_chat"]);

    // Trigger tools default OFF (per-project opt-in), so the base write shape is the
    // 6 write tools + 3 read tools = 9 — no schedule/hook verbs (collapsed in T3).
    const withWrite = selfMcpServerDef(fakeContext(), fakeWrite());
    expect(withWrite.tools).toHaveLength(9);
    expect(withWrite.tools.map((t) => t.name).sort()).toEqual([
      "archive_chat",
      "create_chat",
      "fork_chat",
      "fork_chat_batch",
      "list_chats",
      "list_projects",
      "read_chat",
      "send_message",
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

// ── Unified trigger tools (Epic T "Unify Triggers" / T3) ────────────────────

describe("self-management MCP (trigger tools)", () => {
  it("set_trigger builds a SCHEDULE trigger, defaults project to current, echoes the DTO", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    const { json } = await callWrite(write, "set_trigger", {
      name: "daily-triage",
      type: "schedule",
      cron: "0 9 * * *",
      prompt: "Triage new issues",
      session: "resume",
      tools: "Bash, Read",
    });
    // The handler assembled a structured `{ trigger, run }` partial for the callback.
    expect(write.calls.setTrigger).toEqual([
      {
        projectSlug: "paddock",
        name: "daily-triage",
        trigger: {
          trigger: { type: "schedule", cron: "0 9 * * *" },
          run: { prompt: "Triage new issues", session: "resume", tools: ["Bash", "Read"] },
        },
      },
    ]);
    expect(json.set).toBe(true);
    expect(json.project).toBe("paddock");
    expect(json.trigger).toMatchObject({
      name: "daily-triage",
      type: "schedule",
      cron: "0 9 * * *",
      prompt: "Triage new issues",
      session: "resume",
      tools: ["Bash", "Read"],
    });
  });

  it("set_trigger builds an EVENT trigger with a prompt_file + a target project", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    await callWrite(write, "set_trigger", {
      name: "archive-cleanup",
      type: "event",
      event: "onArchive",
      prompt_file: "cleanup.md",
      tools: "Bash",
      enabled: true,
      project: "herdctl",
    });
    expect(write.calls.setTrigger[0].projectSlug).toBe("herdctl");
    expect(write.calls.setTrigger[0].trigger).toEqual({
      trigger: { type: "event", on: "onArchive" },
      run: { promptFile: "cleanup.md", tools: ["Bash"] },
      enabled: true,
    });
  });

  it("set_trigger builds an interval SCHEDULE + a WEBHOOK trigger", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    await callWrite(write, "set_trigger", { name: "hourly", type: "schedule", interval: "1h", prompt: "go" });
    expect(write.calls.setTrigger[0].trigger).toEqual({
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "go" },
    });

    await callWrite(write, "set_trigger", { name: "gh", type: "webhook", path: "/gh/issues", prompt_file: "triage.md" });
    expect(write.calls.setTrigger[1].trigger).toEqual({
      trigger: { type: "webhook", path: "/gh/issues" },
      run: { promptFile: "triage.md" },
    });
  });

  it("set_trigger is a PARTIAL edit: an enabled-only call omits trigger/run (GG-3 toggle)", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    // No `type` supplied → inherit the existing WHEN; no run fields → inherit run.
    await callWrite(write, "set_trigger", { name: "daily-triage", enabled: false });
    expect(write.calls.setTrigger[0].trigger).toEqual({ enabled: false });
  });

  it("set_trigger passes tools:[] through as a tool-less curator when tools is empty", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    await callWrite(write, "set_trigger", { name: "t", type: "event", event: "onArchive", prompt: "think", tools: "" });
    expect(write.calls.setTrigger[0].trigger).toEqual({
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "think", tools: [] },
    });
  });

  it("set_trigger rejects a missing name / bad type / schedule w/o timer / event w/o event", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    const noName = await callWrite(write, "set_trigger", { type: "event", event: "onArchive", prompt: "x" });
    expect(noName.result.isError).toBe(true);
    expect(noName.result.content[0].text).toContain("`name` is required");

    const badType = await callWrite(write, "set_trigger", { name: "t", type: "weekly", prompt: "x" });
    expect(badType.result.isError).toBe(true);
    expect(badType.result.content[0].text).toContain('`type` must be');

    const noTimer = await callWrite(write, "set_trigger", { name: "t", type: "schedule", prompt: "x" });
    expect(noTimer.result.isError).toBe(true);
    expect(noTimer.result.content[0].text).toContain("`cron`");

    const bothTimers = await callWrite(write, "set_trigger", { name: "t", type: "schedule", cron: "* * * * *", interval: "5m", prompt: "x" });
    expect(bothTimers.result.isError).toBe(true);
    expect(bothTimers.result.content[0].text).toContain("exactly ONE");

    const noEvent = await callWrite(write, "set_trigger", { name: "t", type: "event", prompt: "x" });
    expect(noEvent.result.isError).toBe(true);
    expect(noEvent.result.content[0].text).toContain("`event`");

    // None of the invalid calls should have reached the callback.
    expect(write.calls.setTrigger).toHaveLength(0);
  });

  it("list_triggers defaults project to current and returns the triggers", async () => {
    const triggers = [
      {
        name: "daily",
        agentName: "trigger-paddock-daily",
        type: "schedule" as const,
        cron: "0 9 * * *",
        interval: null,
        event: null,
        path: null,
        prompt: "go",
        promptFile: null,
        session: "resume" as const,
        tools: ["Bash"],
        maxSpawnDepth: 1,
        permissionMode: null,
        model: null,
        maxTurns: null,
        enabled: true,
        status: "idle",
        lastRunAt: null,
        nextRunAt: "2026-07-19T09:00:00Z",
        lastError: null,
      },
    ];
    const write = fakeWrite({ triggersMcpEnabled: true, listTriggers: async () => triggers });
    const { json } = await callWrite(write, "list_triggers", {});
    expect(json).toEqual({ project: "paddock", count: 1, triggers });
  });

  it("remove_trigger defaults project to current, echoes removed, and requires a name", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    const { json } = await callWrite(write, "remove_trigger", { name: "daily" });
    expect(write.calls.removeTrigger).toEqual([{ projectSlug: "paddock", name: "daily" }]);
    expect(json).toEqual({ removed: true, project: "paddock", name: "daily" });

    const { result } = await callWrite(write, "remove_trigger", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("`name` is required");
    expect(write.calls.removeTrigger).toHaveLength(1);
  });

  it("surfaces a setTrigger-callback throw as an isError result rather than throwing", async () => {
    const write = fakeWrite({
      triggersMcpEnabled: true,
      setTrigger: async () => {
        throw new Error("Invalid trigger definition");
      },
    });
    const { result } = await callWrite(write, "set_trigger", {
      name: "t",
      type: "schedule",
      interval: "5m",
      prompt: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid trigger definition");
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

// ── Unified trigger tools: per-project gate (Epic T / T3) ───────────────────

describe("self-management MCP (trigger tools + per-project gate)", () => {
  it("trigger tools are ABSENT when triggersMcpEnabled is off (the default write ctx)", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite());
    const names = def.tools.map((t) => t.name);
    expect(names).not.toContain("list_triggers");
    expect(names).not.toContain("set_trigger");
    expect(names).not.toContain("remove_trigger");
    // The collapsed legacy verbs are gone entirely.
    expect(names).not.toContain("set_schedule");
    expect(names).not.toContain("set_hook");
  });

  it("appends exactly the 4 trigger tools (13 total) when triggersMcpEnabled is on", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite({ triggersMcpEnabled: true }));
    expect(def.tools).toHaveLength(13);
    expect(def.tools.map((t) => t.name).sort()).toEqual([
      "archive_chat",
      "create_chat",
      "fork_chat",
      "fork_chat_batch",
      "list_chats",
      "list_projects",
      "list_triggers",
      "read_chat",
      "remove_trigger",
      "run_trigger",
      "send_message",
      "set_trigger",
      "unarchive_chat",
    ]);
  });

  it("run_trigger fires by name, defaults project to current, and requires a name (#327)", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true });
    const { json } = await callWrite(write, "run_trigger", { name: "daily" });
    expect(write.calls.runTrigger).toEqual([{ projectSlug: "paddock", name: "daily" }]);
    expect(json).toMatchObject({ ran: true, project: "paddock", name: "daily" });
    expect(typeof json.sessionId).toBe("string");

    // A target project is honored.
    await callWrite(write, "run_trigger", { name: "nightly", project: "herdctl" });
    expect(write.calls.runTrigger.at(-1)).toEqual({ projectSlug: "herdctl", name: "nightly" });

    // Missing name → an error, no fire attempted.
    const before = write.calls.runTrigger.length;
    const { result } = await callWrite(write, "run_trigger", {});
    expect(result.isError).toBe(true);
    expect(write.calls.runTrigger).toHaveLength(before);
  });

  it("run_trigger surfaces an error when the fire starts no chat", async () => {
    const write = fakeWrite({ triggersMcpEnabled: true, runTrigger: async () => null });
    const { result } = await callWrite(write, "run_trigger", { name: "gone" });
    expect(result.isError).toBe(true);
  });

  it("trigger tools are absent WITHOUT a write ctx even though they are a write-block feature", () => {
    const def = selfMcpServerDef(fakeContext());
    expect(def.tools.map((t) => t.name)).not.toContain("set_trigger");
  });

  it("names the trigger tools as mcp__paddock_manage__*", () => {
    expect(SELF_MCP_TRIGGER_TOOL_NAMES.listTriggers).toBe("mcp__paddock_manage__list_triggers");
    expect(SELF_MCP_TRIGGER_TOOL_NAMES.setTrigger).toBe("mcp__paddock_manage__set_trigger");
    expect(SELF_MCP_TRIGGER_TOOL_NAMES.removeTrigger).toBe("mcp__paddock_manage__remove_trigger");
    expect(SELF_MCP_TRIGGER_TOOL_NAMES.runTrigger).toBe("mcp__paddock_manage__run_trigger");
  });
});
