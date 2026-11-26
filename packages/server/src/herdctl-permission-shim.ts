/**
 * STAND-IN for an upstream herdctl change (edspencer/paddock#971).
 *
 * herdctl's `toSDKOptions` builds the Agent SDK options from the agent config
 * and forwards neither `permissionPromptToolName` nor `extraArgs`; its agent
 * schema is `.strict()`, so a new config key would be rejected rather than
 * passed through. Until herdctl grows the option, this wraps the SDK runtime's
 * private `buildSdkOptions` so that a session carrying Paddock's injected
 * permission server is pointed at it.
 *
 * What the upstream change would be, in @herdctl/core:
 *   1. `RuntimeExecuteOptions` (and `openChatSession` / `trigger` options) gain
 *      `permissionPromptToolName?: string`, threaded through job-control to
 *      `runtime.openSession` like `injectedMcpServers` is.
 *   2. `SDKRuntime.buildSdkOptions` copies it onto the SDK options.
 *   3. `InjectedMcpServerDef` gains `timeout?: number`, which
 *      `defToSdkMcpServer` passes to `createSdkMcpServer({ timeout })`.
 *   4. The CLI runtime maps (1) to `--permission-prompt-tool`. Its HTTP bridge
 *      would need checking for a request timeout shorter than a human answer.
 *
 * SDK runtime only. CLI-runtime (`driveMode: batch`) chats keep denying asks.
 */
import { SDKRuntime } from "@herdctl/core";
import {
  PERMISSION_PROMPT_SERVER_KEY,
  PERMISSION_PROMPT_TOOL_NAME,
} from "./permission-prompt-mcp.js";

/**
 * Per-call wall-clock limit for the prompt server, in ms: how long a prompt can
 * wait for a human. What governs that wait, read from @anthropic-ai/claude-agent-sdk
 * 0.3.325 and the CLI binary it bundles:
 *  - The SDK reads `timeout` off an `sdk` server's config when it connects it
 *    (`connectSdkMcpServer` in sdk.mjs, via its server-settings parser) and
 *    sends it to the CLI with the server, so setting it after
 *    `createSdkMcpServer` reaches the same field.
 *  - The CLI's per-call limit is that `timeout` when >= 1000, else
 *    `MCP_TOOL_TIMEOUT`, else a built-in 1e8 ms (~28h), clamped to 2^31-1.
 *  - Its idle timeout is off for `sdk` servers unless the host process sets
 *    `CLAUDE_CODE_SDK_MCP_TOOL_IDLE_TIMEOUT`.
 *  - `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`, which herdctl's `buildSdkOptions` raises
 *    only when its own `herdctl-file-sender` server is injected, is referenced by
 *    neither the SDK nor the CLI at this version, so it does not bound the wait.
 * Otherwise the prompt ends only when the turn is aborted (Stop, interrupt).
 * Not yet exercised end to end against a live CLI.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type BuildSdkOptions = (this: unknown, options: unknown) => Record<string, unknown>;

let installed = false;

/** Install once per process; later calls are no-ops. */
export function installPermissionPromptShim(): void {
  if (installed) return;
  installed = true;
  const proto = SDKRuntime.prototype as unknown as { buildSdkOptions?: BuildSdkOptions };
  const original = proto.buildSdkOptions;
  if (typeof original !== "function") {
    // herdctl renamed or removed the method; fail open to today's behaviour.
    console.warn(
      "[paddock] herdctl SDKRuntime.buildSdkOptions not found; permission prompts disabled",
    );
    return;
  }
  proto.buildSdkOptions = function (this: unknown, options: unknown) {
    const sdkOptions = original.call(this, options);
    applyPermissionPrompt(sdkOptions);
    return sdkOptions;
  };
}

/**
 * Point SDK options at Paddock's prompt tool when its server is among the MCP
 * servers. Exported for tests.
 */
export function applyPermissionPrompt(sdkOptions: Record<string, unknown>): void {
  const servers = sdkOptions.mcpServers as Record<string, Record<string, unknown>> | undefined;
  const server = servers?.[PERMISSION_PROMPT_SERVER_KEY];
  if (!server) return;
  sdkOptions.permissionPromptToolName = PERMISSION_PROMPT_TOOL_NAME;
  // `createSdkMcpServer` returns a plain `{ type: "sdk", name, instance }`; the
  // SDK reads an optional `timeout` off the same object.
  server.timeout ??= PERMISSION_PROMPT_TIMEOUT_MS;
}
