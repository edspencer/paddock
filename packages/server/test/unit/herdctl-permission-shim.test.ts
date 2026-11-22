/**
 * `installPermissionPromptShim` (#971) wraps herdctl's private
 * `SDKRuntime.buildSdkOptions`. herdctl is mocked with a stand-in class so each
 * test gets a fresh, once-per-process install and can control whether the
 * private method exists at all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const SERVER_KEY = "paddock_permissions";

async function loadShim(proto: Record<string, unknown>) {
  vi.resetModules();
  class SDKRuntime {}
  Object.assign(SDKRuntime.prototype, proto);
  vi.doMock("@herdctl/core", () => ({ SDKRuntime }));
  const shim = await import("../../src/herdctl-permission-shim.js");
  return { ...shim, proto: SDKRuntime.prototype as Record<string, unknown> };
}

afterEach(() => {
  vi.doUnmock("@herdctl/core");
  vi.restoreAllMocks();
});

describe("installPermissionPromptShim", () => {
  it("points the options at the prompt tool when its server is among them", async () => {
    const original = vi.fn((opts: { servers: Record<string, unknown> }) => ({
      mcpServers: opts.servers,
    }));
    const { installPermissionPromptShim, proto, PERMISSION_PROMPT_TIMEOUT_MS } = await loadShim({
      buildSdkOptions: original,
    });
    installPermissionPromptShim();
    const server: Record<string, unknown> = { type: "sdk" };
    const built = (proto.buildSdkOptions as (o: unknown) => Record<string, unknown>).call(
      {},
      { servers: { [SERVER_KEY]: server } },
    );
    expect(original).toHaveBeenCalledOnce();
    expect(built.permissionPromptToolName).toBe(`mcp__${SERVER_KEY}__approve`);
    expect(server.timeout).toBe(PERMISSION_PROMPT_TIMEOUT_MS);
  });

  it("leaves the options exactly as herdctl built them when the server is absent", async () => {
    const built = { mcpServers: { paddock: { type: "sdk" } }, model: "m" };
    const { installPermissionPromptShim, proto } = await loadShim({
      buildSdkOptions: () => built,
    });
    installPermissionPromptShim();
    const out = (proto.buildSdkOptions as (o: unknown) => unknown).call({}, {});
    expect(out).toEqual({ mcpServers: { paddock: { type: "sdk" } }, model: "m" });
  });

  it("installs once, however often it is called", async () => {
    const original = vi.fn(() => ({}));
    const { installPermissionPromptShim, proto } = await loadShim({ buildSdkOptions: original });
    installPermissionPromptShim();
    const wrapped = proto.buildSdkOptions;
    installPermissionPromptShim();
    expect(proto.buildSdkOptions).toBe(wrapped);
  });

  it("warns and fails open when herdctl no longer has the method", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { installPermissionPromptShim, proto } = await loadShim({});
    expect(() => installPermissionPromptShim()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("permission prompts disabled"));
    expect(proto.buildSdkOptions).toBeUndefined();
  });
});
