/**
 * The permission prompt tool (#971). The CLI parses the tool's single text
 * block as a `PermissionResult`, so these tests pin that JSON for each answer,
 * plus the herdctl stand-in shim that points SDK options at the tool.
 */
import { describe, it, expect } from "vitest";
import {
  permissionPromptServerDef,
  alwaysAllowRule,
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

/** Call the tool, answer the request it parks, and return the parsed JSON. */
async function callAndAnswer(args: Record<string, unknown>, answer: PermissionAnswer | null) {
  const store = new PermissionPromptStore();
  const def = permissionPromptServerDef({
    store,
    projectSlug: "proj",
    currentSessionId: () => "s1",
  });
  const pending = def.tools[0].handler(args) as Promise<Result>;
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

  it("scopes always-allow rules narrowly", () => {
    expect(alwaysAllowRule("Bash", { command: "rm -rf build" })).toEqual({
      toolName: "Bash",
      ruleContent: "rm -rf build",
    });
    expect(alwaysAllowRule("Edit", { file_path: "relative.txt" })).toEqual({ toolName: "Edit" });
    expect(alwaysAllowRule("WebFetch", { url: "https://x" })).toEqual({ toolName: "WebFetch" });
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
