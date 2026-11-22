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
 * Per-call wall-clock limit for the prompt server, in ms. The CLI clamps the
 * value to 2^31-1 and ignores anything under 1000. herdctl does not set one, so
 * without this the CLI default applies: `MCP_TOOL_TIMEOUT` if set, else a large
 * built-in constant (sdk.d.ts calls it "effectively unbounded").
 * The SDK reads `timeout` off the server config when it connects the server
 * (`connectSdkMcpServer` in sdk.mjs), so setting it after `createSdkMcpServer`
 * reaches the same field. TODO: unverified end to end against a live CLI.
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
