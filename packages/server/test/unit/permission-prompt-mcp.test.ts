/**
 * The permission prompt tool (#971). The CLI parses the tool's single text
 * block as a `PermissionResult`, so these tests pin that JSON for each answer,
 * plus the herdctl stand-in shim that points SDK options at the tool.
 */
import { describe, it, expect } from "vitest";
import {
  permissionPromptServerDef,
  alwaysAllowRule,
  promptResultFor,
  PERMISSION_PROMPT_SERVER_KEY,
  PERMISSION_PROMPT_TOOL_NAME,
} from "../../src/permission-prompt-mcp.js";
import { PermissionPromptStore, type PermissionAnswer } from "../../src/permission-prompts.js";
import {
  applyPermissionPrompt,
  PERMISSION_PROMPT_TIMEOUT_MS,
} from "../../src/herdctl-permission-shim.js";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

const EDIT_ARGS = {
  tool_name: "Edit",
  input: { file_path: "/home/u/.claude/CLAUDE.md", old_string: "a", new_string: "b" },
  tool_use_id: "toolu_1",
};

/** The stream showing the turn emitting a tool_use, as the CLI does before it asks. */
function emitToolUse(store: PermissionPromptStore, id: unknown, name: unknown, sessionId = "s1") {
  store.toolUses.observe({
    type: "assistant",
    session_id: sessionId,
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Call the tool, answer the request it parks, and return the parsed JSON. */
async function callAndAnswer(args: Record<string, unknown>, answer: PermissionAnswer | null) {
  const store = new PermissionPromptStore();
  const def = permissionPromptServerDef({
    store,
    projectSlug: "proj",
    currentSessionId: () => "s1",
  });
  emitToolUse(store, args.tool_use_id, args.tool_name);
  const pending = def.tools[0].handler(args) as Promise<Result>;
  await tick();
  const [req] = store.pendingFor("s1");
  if (answer) store.answer("s1", req.id, answer);
  else store.cancelSession("s1", "the turn was stopped");
  const result = await pending;
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return { req, json: JSON.parse(result.content[0].text) };
}

describe("permission prompt tool", () => {
  it("is named so the CLI can address it", () => {
    expect(PERMISSION_PROMPT_TOOL_NAME).toBe(`mcp__${PERMISSION_PROMPT_SERVER_KEY}__approve`);
    // The CLI refuses a prompt server whose name reads as a claude.ai connector.
    expect(PERMISSION_PROMPT_SERVER_KEY).not.toMatch(/^claude_?ai_/);
  });

  it("parks the request with the CLI's tool name, input and tool_use id", async () => {
    const { req } = await callAndAnswer(EDIT_ARGS, "once");
    expect(req).toMatchObject({
      projectSlug: "proj",
      sessionId: "s1",
      toolName: "Edit",
      input: EDIT_ARGS.input,
      toolUseId: "toolu_1",
    });
  });

  it("approve once -> allow with the input unchanged", async () => {
    const { json } = await callAndAnswer(EDIT_ARGS, "once");
    expect(json).toEqual({
      behavior: "allow",
      updatedInput: EDIT_ARGS.input,
      decisionClassification: "user_temporary",
    });
  });

  it("approve always -> allow plus a session rule for that file", async () => {
    const { json } = await callAndAnswer(EDIT_ARGS, "always");
    expect(json).toEqual({
      behavior: "allow",
      updatedInput: EDIT_ARGS.input,
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Edit", ruleContent: "//home/u/.claude/CLAUDE.md" }],
          behavior: "allow",
          destination: "session",
        },
      ],
      decisionClassification: "user_permanent",
    });
  });

  it("deny -> deny with a message", async () => {
    const { json } = await callAndAnswer(EDIT_ARGS, "deny");
    expect(json).toMatchObject({ behavior: "deny", decisionClassification: "user_reject" });
    expect(typeof json.message).toBe("string");
  });

  it("a cancelled request -> deny naming the reason", async () => {
    const { json } = await callAndAnswer(EDIT_ARGS, null);
    expect(json).toEqual({
      behavior: "deny",
      message: "Permission request cancelled (the turn was stopped).",
    });
  });

  it("denies at once when no chat session is known yet", async () => {
    const store = new PermissionPromptStore();
    const def = permissionPromptServerDef({
      store,
      projectSlug: "p",
      currentSessionId: () => null,
    });
    const result = (await def.tools[0].handler(EDIT_ARGS)) as Result;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ behavior: "deny" });
    expect(store.snapshot()).toEqual([]);
  });

  describe("a call the turn did not make (the model calling the tool itself)", () => {
    const setup = () => {
      const store = new PermissionPromptStore();
      const settled: unknown[] = [];
      store.onSettle = (req) => settled.push(req);
      const def = permissionPromptServerDef({
        store,
        projectSlug: "proj",
        currentSessionId: () => "s1",
        sightingGraceMs: 20,
      });
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(((await def.tools[0].handler(args)) as Result).content[0].text);
      return { store, settled, call };
    };

    it("denies, shows no card and records nothing for an id the stream never emitted", async () => {
      const { store, settled, call } = setup();
      expect(await call(EDIT_ARGS)).toMatchObject({ behavior: "deny" });
      expect(store.snapshot()).toEqual([]);
      expect(settled).toEqual([]);
    });

    it("denies a call with no tool_use id", async () => {
      const { store, call } = setup();
      const { tool_use_id: _, ...args } = EDIT_ARGS;
      emitToolUse(store, "toolu_1", "Edit");
      expect(await call(args)).toMatchObject({ behavior: "deny" });
      expect(store.snapshot()).toEqual([]);
    });

    it("denies an id whose call already has its result", async () => {
      const { store, call } = setup();
      emitToolUse(store, "toolu_1", "Edit");
      store.toolUses.observe({
        type: "user",
        session_id: "s1",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      });
      expect(await call(EDIT_ARGS)).toMatchObject({ behavior: "deny" });
    });

    it("denies an id naming a different tool, or one from another chat", async () => {
      const { store, call } = setup();
      emitToolUse(store, "toolu_1", "Read");
      emitToolUse(store, "toolu_2", "Edit", "other");
      expect(await call(EDIT_ARGS)).toMatchObject({ behavior: "deny" });
      expect(await call({ ...EDIT_ARGS, tool_use_id: "toolu_2" })).toMatchObject({
        behavior: "deny",
      });
    });

    it("waits for a tool_use the stream delivers after the prompt arrives", async () => {
      const { store } = setup();
      const def = permissionPromptServerDef({
        store,
        projectSlug: "proj",
        currentSessionId: () => "s1",
        sightingGraceMs: 1000,
      });
      const pending = def.tools[0].handler(EDIT_ARGS) as Promise<Result>;
      await tick();
      expect(store.pendingFor("s1")).toEqual([]);
      emitToolUse(store, "toolu_1", "Edit");
      await tick();
      const [req] = store.pendingFor("s1");
      store.answer("s1", req.id, "once");
      expect(JSON.parse((await pending).content[0].text)).toMatchObject({ behavior: "allow" });
    });
  });

  it("scopes always-allow rules to the exact file or command, else offers none", () => {
    expect(alwaysAllowRule("Bash", { command: "rm -rf build" })).toEqual({
      toolName: "Bash",
      ruleContent: "rm -rf build",
    });
    // Each of these could only be a bare rule allowing every later use of the tool.
    expect(alwaysAllowRule("Bash", {})).toBeNull();
    expect(alwaysAllowRule("Bash", { command: "" })).toBeNull();
    expect(alwaysAllowRule("Edit", { file_path: "relative.txt" })).toBeNull();
    expect(alwaysAllowRule("WebFetch", { url: "https://x" })).toBeNull();
    expect(alwaysAllowRule("Read", { file_path: "/etc/hosts" })).toBeNull();
    expect(alwaysAllowRule("Task", { prompt: "go" })).toBeNull();
    expect(alwaysAllowRule("mcp__s__t", { a: 1 })).toBeNull();
  });

  it.each([
    "rm -rf build/*",
    "git log --format=%h:*",
    "echo $(whoami)",
    "(cd x && ls)",
    "printf 'a\\n'",
  ])("offers no always for a Bash command with rule syntax: %s", (command) => {
    expect(alwaysAllowRule("Bash", { command })).toBeNull();
  });

  it.each([
    "/x/*.ts",
    "/x/a?.ts",
    "/x/[ab].ts",
    "/x/{a,b}.ts",
    "/x/(a).ts",
    "/x/!a",
    "/x/#a",
    "/x/a\\b",
    "/x/a ",
  ])("offers no always for an edit of a path with glob syntax: %s", (file_path) => {
    expect(alwaysAllowRule("Write", { file_path })).toBeNull();
  });

  it("still scopes plain commands and paths", () => {
    expect(alwaysAllowRule("Bash", { command: "npm run build -- --watch=false" })).toEqual({
      toolName: "Bash",
      ruleContent: "npm run build -- --watch=false",
    });
    expect(alwaysAllowRule("Write", { file_path: "/home/u/.claude/a-b_c.d/x.md" })).toEqual({
      toolName: "Write",
      ruleContent: "//home/u/.claude/a-b_c.d/x.md",
    });
  });

  it("flags whether always is on offer when it parks the request", async () => {
    expect((await callAndAnswer(EDIT_ARGS, "once")).req.alwaysAllowed).toBe(true);
    const fetch = { tool_name: "WebFetch", input: { url: "https://x" }, tool_use_id: "t2" };
    expect((await callAndAnswer(fetch, "once")).req.alwaysAllowed).toBe(false);
  });

  it("answers always as once, with no session rule, when no exact rule exists", async () => {
    const fetch = { tool_name: "WebFetch", input: { url: "https://x" }, tool_use_id: "t2" };
    const { json } = await callAndAnswer(fetch, "always");
    expect(json).toEqual({
      behavior: "allow",
      updatedInput: fetch.input,
      decisionClassification: "user_temporary",
    });
  });

  it("never builds a bare rule even when called with always directly", () => {
    const r = promptResultFor({ kind: "answered", answer: "always" }, "Read", { file_path: "/x" });
    expect(r).not.toHaveProperty("updatedPermissions");
  });
});

describe("herdctl permission shim", () => {
  it("sets the prompt tool name and a long timeout when the server is injected", () => {
    const server: Record<string, unknown> = { type: "sdk", name: PERMISSION_PROMPT_SERVER_KEY };
    const opts: Record<string, unknown> = {
      mcpServers: { [PERMISSION_PROMPT_SERVER_KEY]: server },
    };
    applyPermissionPrompt(opts);
    expect(opts.permissionPromptToolName).toBe(PERMISSION_PROMPT_TOOL_NAME);
    expect(server.timeout).toBe(PERMISSION_PROMPT_TIMEOUT_MS);
  });

  it("leaves options alone when the server is absent", () => {
    const opts: Record<string, unknown> = { mcpServers: { paddock: {} } };
    applyPermissionPrompt(opts);
    expect(opts.permissionPromptToolName).toBeUndefined();
  });
});
