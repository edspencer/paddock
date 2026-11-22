/**
 * Paddock-native permission prompt tool (edspencer/paddock#971, #178).
 *
 * Injected like `send-file-mcp.ts` (herdctl `injectedMcpServers`, handler runs
 * in the Paddock server process), but called by the Claude Code CLI rather than
 * the model. The SDK option `permissionPromptToolName` (CLI flag
 * `--permission-prompt-tool`) names this tool; whenever a tool use resolves to
 * "ask", the CLI calls it instead of denying outright. herdctl does not forward
 * that option yet — see `herdctl-permission-shim.ts`.
 *
 * ── Wire contract (read from @anthropic-ai/claude-agent-sdk 0.3.283) ──────────
 * Input, from the CLI:  `{ tool_name, input, tool_use_id }`. Unlike the
 * `canUseTool` callback, the MCP path is NOT given `suggestions`,
 * `blockedPath` or `decisionReason`, so "always allow" builds its own rule.
 * Output: ONE text block whose text is JSON, parsed against the same schema as
 * a `canUseTool` result (`PermissionResult` in sdk.d.ts):
 *   { behavior: "allow", updatedInput?, updatedPermissions?, decisionClassification? }
 *   { behavior: "deny", message, interrupt?, decisionClassification? }
 * A schema-invalid result is treated by the CLI as a deny.
 */
import type { InjectedMcpServerDef, McpToolCallResult } from "@herdctl/core";
import type {
  PermissionAnswer,
  PermissionOutcome,
  PermissionPromptStore,
} from "./permission-prompts.js";

/**
 * Structural copies of the SDK's `PermissionRuleValue` / `PermissionUpdate`
 * (only the variant used here). Kept local because the server package does not
 * depend on the Agent SDK directly.
 */
interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}
interface AddRulesUpdate {
  type: "addRules";
  rules: PermissionRuleValue[];
  behavior: "allow";
  destination: "session";
}

/** The JSON the tool returns, mirroring the SDK's `PermissionResult`. */
export type PermissionPromptResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: AddRulesUpdate[];
      decisionClassification: "user_temporary" | "user_permanent";
    }
  | { behavior: "deny"; message: string; decisionClassification?: "user_reject" };

/** Per-turn context: which chat a prompt belongs to. */
export interface PermissionPromptContext {
  store: PermissionPromptStore;
  projectSlug: string;
  /**
   * The chat's session id. A getter because a brand-new chat learns its id
   * mid-stream, after this def is built (the same reason the self-MCP takes one).
   */
  currentSessionId: () => string | null;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The rule "Always" adds for the rest of the session. Scoped to the exact file
 * for edit tools and the exact command for Bash, so one click does not open up
 * every edit or every command.
 *
 * TODO: the CLI's own suggestions would be better than this guess, but the MCP
 * prompt path does not receive them. Unverified: whether a session rule lifts a
 * sensitive-file safetyCheck at all, or that check asks again regardless.
 */
export function alwaysAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): PermissionRuleValue {
  const filePath = input.file_path ?? input.notebook_path;
  if (EDIT_TOOLS.has(toolName) && typeof filePath === "string" && filePath.startsWith("/")) {
    // `//` anchors an absolute path in Claude Code's gitignore-style path rules.
    return { toolName, ruleContent: `/${filePath}` };
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    return { toolName, ruleContent: input.command };
  }
  return { toolName };
}

/** Map a settled request onto the JSON the CLI expects. */
export function promptResultFor(
  outcome: PermissionOutcome,
  toolName: string,
  input: Record<string, unknown>,
): PermissionPromptResult {
  if (outcome.kind === "cancelled") {
    return { behavior: "deny", message: `Permission request cancelled (${outcome.reason}).` };
  }
  const answers: Record<PermissionAnswer, () => PermissionPromptResult> = {
    once: () => ({
      behavior: "allow",
      updatedInput: input,
      decisionClassification: "user_temporary",
    }),
    always: () => ({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [
        {
          type: "addRules",
          rules: [alwaysAllowRule(toolName, input)],
          behavior: "allow",
          destination: "session",
        },
      ],
      decisionClassification: "user_permanent",
    }),
    deny: () => ({
      behavior: "deny",
      message: "The user denied this request in Paddock.",
      decisionClassification: "user_reject",
    }),
  };
  return answers[outcome.answer]();
}

function result(r: PermissionPromptResult): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
}

/**
 * The handler. Takes the MCP SDK's `extra` as an optional second argument:
 * herdctl hands the handler straight to the Agent SDK's `tool()`, which passes
 * it, though herdctl's own type only names `args`. Its `signal` fires if the
 * CLI abandons the call.
 */
function createHandler(context: PermissionPromptContext) {
  return async (
    args: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult> => {
    const toolName = typeof args.tool_name === "string" ? args.tool_name : "unknown";
    const input =
      args.input && typeof args.input === "object" && !Array.isArray(args.input)
        ? (args.input as Record<string, unknown>)
        : {};
    const sessionId = context.currentSessionId();
    if (!sessionId) {
      // Nothing can route the card to a chat yet; deny as the CLI did before.
      return result({ behavior: "deny", message: "No Paddock chat is attached to answer this." });
    }
    const outcome = await context.store.open(
      {
        projectSlug: context.projectSlug,
        sessionId,
        toolName,
        input,
        ...(typeof args.tool_use_id === "string" ? { toolUseId: args.tool_use_id } : {}),
      },
      extra?.signal,
    );
    return result(promptResultFor(outcome, toolName, input));
  };
}

// Must not look like a claude.ai connector name (`claude_ai_…` / `claudeai_…`):
// the CLI refuses those as a prompt server.
const SERVER_NAME = "paddock_permissions";
const TOOL_NAME = "approve";

// TODO: the model also sees this tool and could call it. Nothing it can do with
// it bypasses a check (it only asks the user), but hiding it from the model's
// tool list without hiding it from the CLI's prompt-tool lookup is unverified.
const TOOL_DESCRIPTION =
  "Internal to Paddock: asks the user to approve a tool use. Called by Claude Code " +
  "itself for permission prompts. Do not call this tool.";

const TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tool_name: { type: "string", description: "The tool that needs approval." },
    input: { type: "object", description: "That tool's input." },
    tool_use_id: { type: "string", description: "The tool_use id being approved." },
  },
  required: ["tool_name", "input"],
};

/** Build the injected server def, bound to one chat. */
export function permissionPromptServerDef(context: PermissionPromptContext): InjectedMcpServerDef {
  return {
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: TOOL_INPUT_SCHEMA,
        handler: createHandler(context),
      },
    ],
  };
}

/** The record key + the fully-qualified name passed as `permissionPromptToolName`. */
export const PERMISSION_PROMPT_SERVER_KEY = SERVER_NAME;
export const PERMISSION_PROMPT_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
