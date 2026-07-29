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
  SELF_MCP_PROJECT_TOOL_NAMES,
  SELF_MCP_TRIGGER_TOOL_NAMES,
  redactPaths,
  FORK_BATCH_MAX,
  coercePrompts,
  coerceToolList,
  resolveModelArg,
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
  type SelfMcpCreateProjectInput,
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
  { project: "paddock", sessionId: "aaa", name: "Chat A", updatedAt: "2026-07-14T00:00:00Z", running: true, archived: false },
  { project: "herdctl", sessionId: "bbb", name: "Chat B", updatedAt: "2026-07-13T00:00:00Z", running: false, archived: false },
  // #489: archived — hidden from the default listing, and the reason
  // `omittedArchived` exists.
  { project: "paddock", sessionId: "ccc", name: "Chat C", updatedAt: "2026-07-12T00:00:00Z", running: false, archived: true },
];

function fakeContext(over: Partial<SelfMcpContext> = {}): SelfMcpContext {
  return {
    listProjects: async () => PROJECTS,
    // `!== undefined`, not truthiness: the op's contract is that ABSENT means
    // "every workspace" while `""` ADDRESSES the root one (#560). A fake that
    // tested `slug ?` here would hide the very bug these tests pin.
    listChats: async (slug) => (slug !== undefined ? CHATS.filter((c) => c.project === slug) : CHATS),
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

  // ── #489: archived chats are hidden by default, but never SILENTLY ─────────

  it("list_chats HIDES archived chats by default and reports how many it hid", async () => {
    const { json } = await call(fakeContext(), "list_chats");
    expect(json.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["aaa", "bbb"]);
    expect(json.count).toBe(2);
    // The load-bearing part: list_chats is the only source of session ids, so a
    // caller must be able to SEE that something was withheld.
    expect(json.omittedArchived).toBe(1);
  });

  it("list_chats with include_archived returns archived chats and their flag", async () => {
    const { json } = await call(fakeContext(), "list_chats", { include_archived: true });
    expect(json.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["aaa", "bbb", "ccc"]);
    expect(json.count).toBe(3);
    expect(json.omittedArchived).toBe(0);
    expect(json.chats.find((c: SelfMcpChat) => c.sessionId === "ccc").archived).toBe(true);
  });

  it("list_chats composes include_archived with the project filter", async () => {
    const { json: hidden } = await call(fakeContext(), "list_chats", { project: "paddock" });
    expect(hidden.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["aaa"]);
    expect(hidden.omittedArchived).toBe(1);

    const { json: shown } = await call(fakeContext(), "list_chats", {
      project: "paddock",
      include_archived: true,
    });
    expect(shown.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["aaa", "ccc"]);
    expect(shown.omittedArchived).toBe(0);
  });

  it("list_chats accepts include_archived as a STRING (lossy CLI MCP transport)", async () => {
    const { json: on } = await call(fakeContext(), "list_chats", { include_archived: "true" });
    expect(on.count).toBe(3);
    const { json: off } = await call(fakeContext(), "list_chats", { include_archived: "False" });
    expect(off.count).toBe(2);
    // A junk value falls back to the default rather than erroring a read.
    const { json: junk } = await call(fakeContext(), "list_chats", { include_archived: "yes" });
    expect(junk.count).toBe(2);
  });

  it("list_chats declares include_archived in its inputSchema", () => {
    const schema = toolByName(fakeContext(), "list_chats").inputSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(schema.properties.include_archived?.type).toBe("boolean");
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

// ── #560: the ROOT workspace is an address, not an absence ───────────────────
// A workspace key is a path relative to `projectsRoot`, so the root's key is the
// EMPTY STRING. Every read here used to test it for truthiness, which made the
// root's chats unlistable and unreadable — and did it silently: `project: ""`
// got another target's answer, and `read_chat` called a supplied arg missing.

/** The root workspace as `list_projects`' op reports it (an ordinary member). */
const ROOT_PROJECT: SelfMcpProject = { slug: "", name: "projects", status: "active" };

/** One chat in the root workspace, alongside the project chats in CHATS. */
const ROOT_CHAT: SelfMcpChat = {
  project: "",
  sessionId: "rrr",
  name: "Root chat",
  updatedAt: "2026-07-15T00:00:00Z",
  running: false,
  archived: false,
};

const ALL_CHATS = [ROOT_CHAT, ...CHATS];

/** A context whose store holds the root workspace as well as two projects. */
function rootAwareContext(over: Partial<SelfMcpContext> = {}): SelfMcpContext {
  return fakeContext({
    listProjects: async () => [ROOT_PROJECT, ...PROJECTS],
    listChats: async (slug) =>
      slug !== undefined ? ALL_CHATS.filter((c) => c.project === slug) : ALL_CHATS,
    ...over,
  });
}

describe("#560: the root workspace is reachable through the MCP surface", () => {
  it("list_projects reports the root as its OWN field, outside projects/count", async () => {
    const { json } = await call(rootAwareContext(), "list_projects");
    // The root is NOT a project: `ProjectStore.list()` enumerates children only,
    // and that exclusion is deliberate (root-workspace.test.ts). So it must not
    // leak into the array or the count…
    expect(json.projects.map((p: SelfMcpProject) => p.slug)).toEqual(["paddock", "herdctl"]);
    expect(json.count).toBe(2);
    // …but a caller still has to be able to LEARN it exists, or it can never
    // reach the root's chats.
    expect(json.root).toEqual({ slug: "", name: "projects", status: "active" });
  });

  it("list_projects reports root: null when the store has no root to offer", async () => {
    // e.g. a scoped external principal whose `projects` list doesn't match `""`;
    // the policy wrapper filters it out before the handler ever sees it.
    const { json } = await call(fakeContext(), "list_projects");
    expect(json.root).toBeNull();
    expect(json.count).toBe(2);
  });

  it('list_chats {"project":""} returns the ROOT\'s chats, not every project\'s', async () => {
    const { json } = await call(rootAwareContext(), "list_chats", { project: "" });
    // The bug: this silently answered with all 3 project chats.
    expect(json.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["rrr"]);
    expect(json.count).toBe(1);
    // …and the echoed target stays `""`, distinguishable from the unfiltered null.
    expect(json.project).toBe("");
  });

  it("passes the empty key THROUGH to the op rather than collapsing it", async () => {
    const seen: Array<string | undefined> = [];
    const ctx = rootAwareContext({
      listChats: async (slug) => {
        seen.push(slug);
        return [];
      },
    });
    await call(ctx, "list_chats", { project: "" });
    await call(ctx, "list_chats", {});
    expect(seen).toEqual(["", undefined]);
  });

  it("list_chats with no project covers the root as well as every project", async () => {
    const { json } = await call(rootAwareContext(), "list_chats");
    expect(json.project).toBeNull();
    // Design call (#560): unfiltered means EVERY workspace. Omitting the root
    // here is what made its chats undiscoverable — list_chats is the only source
    // of session ids, so a root chat was unreachable even once `""` worked.
    expect(json.chats.map((c: SelfMcpChat) => c.sessionId)).toEqual(["rrr", "aaa", "bbb"]);
    expect(json.count).toBe(3);
    expect(json.omittedArchived).toBe(1);
  });

  it("read_chat accepts the root's empty key and echoes it back", async () => {
    const seen: Array<[string, string]> = [];
    const ctx = rootAwareContext({
      readChat: async (slug, sessionId) => {
        seen.push([slug, sessionId]);
        return [{ role: "assistant", text: "from the root keeper", timestamp: "t" }];
      },
    });
    const { result, json } = await call(ctx, "read_chat", { project: "", session_id: "rrr" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([["", "rrr"]]);
    expect(json.project).toBe("");
    expect(json.messages[0].text).toBe("from the root keeper");
  });

  it("read_chat still refuses a genuinely ABSENT project (the guard must survive)", async () => {
    const ctx = rootAwareContext({
      readChat: async () => {
        throw new Error("must not be reached");
      },
    });
    for (const args of [{ session_id: "rrr" }, { project: 7, session_id: "rrr" }]) {
      const { result } = await call(ctx, "read_chat", args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`project`");
    }
  });

  it("tells the agent about the empty key in the schema it reads", () => {
    const props = (name: string) =>
      (toolByName(rootAwareContext(), name).inputSchema as {
        properties: Record<string, { description: string }>;
      }).properties;
    // The old text ("Omit to list chats across all projects") is a large part of
    // why `project: ""` looked like "omit it"; the schema has to name the key.
    for (const tool of ["list_chats", "read_chat"]) {
      expect(props(tool).project.description).toMatch(/root/i);
      expect(props(tool).project.description).toContain('""');
    }
  });
});

// ── Phase 2: write tools ────────────────────────────────────────────────────

interface RecordingWrite extends SelfMcpWriteContext {
  calls: {
    createChat: Array<{ projectSlug: string; prompt: string; opts?: { name?: string; preloadContext?: boolean; model?: string } }>;
    forkChat: Array<{ projectSlug: string; sourceSessionId: string; prompt?: string; name?: string; model?: string }>;
    sendMessage: Array<{ projectSlug: string; sessionId: string; prompt: string }>;
    setArchived: Array<{ projectSlug: string; sessionId: string; archived: boolean }>;
    createProject: SelfMcpCreateProjectInput[];
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
    createProject: [],
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
    // Project provisioning (#467): default OFF (its own instance opt-in) so the base
    // 9-tool shape is unchanged; a test opts in via `fakeWrite({ projectsMcpEnabled: true })`.
    projectsMcpEnabled: false,
    createProject: async (input) => {
      calls.createProject.push(input);
      const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const dir = `/srv/paddock/projects/${slug}`;
      return {
        slug,
        name: input.name,
        dir,
        // A repo-backed project's cwd is the nested checkout; a notebook's is its dir.
        workingDir: input.repo ? `${dir}/checkout` : dir,
        repoBacked: Boolean(input.repo),
        ...(input.repo ? { repo: input.repo } : {}),
        keeperRegistered: true,
      };
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

  // ── Per-chat model override (issue #336) ──────────────────────────────────

  it("create_chat threads a valid model through to createChat + echoes it", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "create_chat", { prompt: "go", model: "claude-sonnet-5" });
    expect(json.model).toBe("claude-sonnet-5");
    expect(write.calls.createChat[0].opts?.model).toBe("claude-sonnet-5");
  });

  it("create_chat omits model (inherits default) when the arg is absent", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "create_chat", { prompt: "go" });
    expect("model" in json).toBe(false);
    expect(write.calls.createChat[0].opts?.model).toBeUndefined();
  });

  it("create_chat rejects an unknown model (allow-list) and does NOT spawn", async () => {
    const write = fakeWrite();
    const { result } = await callWrite(write, "create_chat", { prompt: "go", model: "gpt-4o" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown model "gpt-4o"');
    expect(write.calls.createChat).toHaveLength(0);
  });

  it("create_chat treats a blank model as absent (inherits default)", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "create_chat", { prompt: "go", model: "   " });
    expect("model" in json).toBe(false);
    expect(write.calls.createChat[0].opts?.model).toBeUndefined();
  });

  it("fork_chat threads a valid model through + rejects an unknown one", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat", { prompt: "branch", model: "claude-haiku-4-5-20251001" });
    expect(json.model).toBe("claude-haiku-4-5-20251001");
    expect(write.calls.forkChat[0].model).toBe("claude-haiku-4-5-20251001");

    const bad = await callWrite(fakeWrite(), "fork_chat", { prompt: "branch", model: "nope" });
    expect(bad.result.isError).toBe(true);
  });

  it("fork_chat_batch applies ONE model to every fork + rejects an unknown one", async () => {
    const write = fakeWrite();
    const { json } = await callWrite(write, "fork_chat_batch", {
      prompts: ["a", "b"],
      model: "claude-sonnet-5",
    });
    expect(json.model).toBe("claude-sonnet-5");
    expect(write.calls.forkChat.map((c) => c.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5"]);

    const bad = await callWrite(fakeWrite(), "fork_chat_batch", { prompts: ["a"], model: "bad-model" });
    expect(bad.result.isError).toBe(true);
  });

  it("the spawn tools advertise the `model` param listing the picker allow-list", () => {
    const def = selfMcpServerDef(fakeContext(), fakeWrite());
    for (const name of ["create_chat", "fork_chat", "fork_chat_batch"]) {
      const tool = def.tools.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.model).toBeDefined();
      expect(props.model.description).toContain("claude-sonnet-5");
    }
  });

  it("resolveModelArg validates against the allow-list", () => {
    expect(resolveModelArg(undefined)).toEqual({});
    expect(resolveModelArg("")).toEqual({});
    expect(resolveModelArg("   ")).toEqual({});
    expect(resolveModelArg("claude-opus-4-8")).toEqual({ model: "claude-opus-4-8" });
    expect(resolveModelArg(" claude-sonnet-5 ")).toEqual({ model: "claude-sonnet-5" });
    const err = resolveModelArg("gpt-4o");
    expect(typeof err).toBe("string");
    expect(err as string).toContain("Valid models:");
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

  it("run_trigger propagates a thrown error (e.g. the non-runnable curator) as the message", async () => {
    const write = fakeWrite({
      triggersMcpEnabled: true,
      runTrigger: async () => {
        throw new Error("the post-turn curator trigger runs automatically after each turn and can't be run on demand");
      },
    });
    const { result } = await callWrite(write, "run_trigger", { name: "curate-overview" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("post-turn curator");
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

// ── create_project (issue #467) ─────────────────────────────────────────────

describe("self-management MCP (create_project)", () => {
  it("is ABSENT unless projectsMcpEnabled is on — even with the write tools present", () => {
    const off = selfMcpServerDef(fakeContext(), fakeWrite());
    expect(off.tools.map((t) => t.name)).not.toContain("create_project");

    const on = selfMcpServerDef(fakeContext(), fakeWrite({ projectsMcpEnabled: true }));
    expect(on.tools.map((t) => t.name)).toContain("create_project");
    // Its own gate — it does NOT drag the trigger tools in with it.
    expect(on.tools.map((t) => t.name)).not.toContain("set_trigger");
    expect(on.tools).toHaveLength(10);
  });

  it("is absent WITHOUT a write ctx at all (it lives in the write block)", () => {
    const def = selfMcpServerDef(fakeContext());
    expect(def.tools.map((t) => t.name)).not.toContain("create_project");
  });

  it("names the project tool as mcp__paddock_manage__create_project", () => {
    expect(SELF_MCP_PROJECT_TOOL_NAMES.createProject).toBe("mcp__paddock_manage__create_project");
  });

  it("creates a NOTEBOOK project from just a name, deriving the slug", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    const { json } = await callWrite(write, "create_project", { name: "Paddock Deploy" });
    expect(write.calls.createProject).toEqual([{ name: "Paddock Deploy" }]);
    expect(json.created).toBe(true);
    expect(json.slug).toBe("paddock-deploy");
    expect(json.repoBacked).toBe(false);
    expect(json.repo).toBeUndefined();
    expect(json.workingDir).toBe(json.dir);
    expect(json.keeperRegistered).toBe(true);
  });

  it("passes every optional field through, mapping `area` onto the project's group", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    const { json } = await callWrite(write, "create_project", {
      name: "Hello World",
      slug: "hello-world",
      repo: "https://github.com/octocat/Hello-World",
      summary: " a tiny public repo ",
      area: " Homelab ",
      status: "Idea",
    });
    expect(write.calls.createProject).toEqual([
      {
        name: "Hello World",
        slug: "hello-world",
        repo: "https://github.com/octocat/Hello-World",
        summary: "a tiny public repo",
        group: "Homelab",
        status: "idea",
      },
    ]);
    // Repo-backed: the keeper's cwd is the nested checkout, not the metadata dir.
    expect(json.repoBacked).toBe(true);
    expect(json.repo).toBe("https://github.com/octocat/Hello-World");
    expect(json.workingDir).not.toBe(json.dir);
  });

  it("requires a non-blank name", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    for (const args of [{}, { name: "   " }, { name: 42 }]) {
      const { result } = await callWrite(write, "create_project", args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`name` is required");
    }
    expect(write.calls.createProject).toEqual([]);
  });

  it("rejects a non-kebab-case slug before touching the store", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    for (const slug of ["Not Kebab", "UPPER", "trailing-", "double--hyphen", "under_score"]) {
      const { result } = await callWrite(write, "create_project", { name: "X", slug });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("invalid slug");
    }
    expect(write.calls.createProject).toEqual([]);
  });

  it("rejects a malformed repo URL before touching the store", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    const { result } = await callWrite(write, "create_project", {
      name: "X",
      repo: "github.com/octocat/Hello-World",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid repo URL");
    expect(write.calls.createProject).toEqual([]);
  });

  it("rejects an unknown status, listing the valid ones", async () => {
    const write = fakeWrite({ projectsMcpEnabled: true });
    const { result } = await callWrite(write, "create_project", { name: "X", status: "wip" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown status "wip"');
    expect(result.content[0].text).toContain("active");
    expect(write.calls.createProject).toEqual([]);
  });

  it("surfaces a duplicate-slug store error as a clean isError", async () => {
    const write = fakeWrite({
      projectsMcpEnabled: true,
      createProject: async () => {
        throw new Error("Project already exists: paddock");
      },
    });
    const { result } = await callWrite(write, "create_project", { name: "Paddock" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error creating project: Project already exists: paddock");
  });

  it("surfaces a CLONE FAILURE cleanly, keeping the repo URL but redacting server paths", async () => {
    // What the real path throws: ProjectStore.create wraps cloneRepo, which wraps
    // promisify(execFile) — whose message is git's WHOLE argv, destination included.
    const write = fakeWrite({
      projectsMcpEnabled: true,
      createProject: async () => {
        throw new Error(
          "git clone failed: Command failed: git clone -- https://github.com/octocat/does-not-exist " +
            "/srv/paddock/projects/nope/does-not-exist\n" +
            "remote: Repository not found.\n" +
            "fatal: repository 'https://github.com/octocat/does-not-exist/' not found\n",
        );
      },
    });
    const { result } = await callWrite(write, "create_project", {
      name: "Nope",
      repo: "https://github.com/octocat/does-not-exist",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // The actionable parts survive…
    expect(text).toContain("Repository not found");
    expect(text).toContain("https://github.com/octocat/does-not-exist");
    // …but the server's on-disk layout does not.
    expect(text).not.toContain("/srv/paddock/projects");
    expect(text).toContain("<path>");
  });

  it("reports keeperRegistered:false rather than failing when agent registration fails", async () => {
    const write = fakeWrite({
      projectsMcpEnabled: true,
      createProject: async (input) => ({
        slug: input.name,
        name: input.name,
        dir: "/srv/x",
        workingDir: "/srv/x",
        repoBacked: false,
        keeperRegistered: false,
      }),
    });
    const { result, json } = await callWrite(write, "create_project", { name: "x" });
    expect(result.isError).toBeUndefined();
    expect(json.created).toBe(true);
    expect(json.keeperRegistered).toBe(false);
  });
});

describe("redactPaths", () => {
  it("strips multi-segment absolute paths but leaves URLs intact", () => {
    expect(redactPaths("failed at /var/lib/paddock/projects/foo now")).toBe(
      "failed at <path> now",
    );
    expect(redactPaths("cloning https://github.com/octocat/Hello-World.git")).toBe(
      "cloning https://github.com/octocat/Hello-World.git",
    );
    expect(redactPaths("git clone -- git@github.com:octocat/Hello-World.git /srv/data/p/x")).toBe(
      "git clone -- git@github.com:octocat/Hello-World.git <path>",
    );
    // Nothing path-like ⇒ unchanged.
    expect(redactPaths("Project already exists: paddock")).toBe("Project already exists: paddock");
  });
});
