/**
 * HerdctlService.ensureKeeperModel — the per-chat model-override primitive the
 * self-MCP spawn tools rely on (issue #336).
 *
 * A spawned chat (`create_chat` / `fork_chat` / `fork_chat_batch` with a `model`)
 * runs on the project's SHARED keeper agent, so a per-chat model override is applied
 * by re-registering that agent at the requested model right before the kickoff turn
 * — the SAME mechanism the human model-picker uses. These tests drive a real
 * HerdctlService against a fake fleet recording `addAgent` to prove:
 *   1. ensureKeeperModel re-registers the keeper at the requested model, and
 *   2. it's idempotent — a repeat for the SAME model does NOT re-register (so a
 *      fork_chat_batch fanning N forks on one model registers once, not N times).
 */
import { describe, it, expect, vi } from "vitest";
import { HerdctlService, keeperAgentName } from "../../src/herdctl.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

function svcWithFakeFleet() {
  const added: Array<Record<string, unknown>> = [];
  const svc = new HerdctlService({} as PaddockConfig);
  (svc as unknown as { fleet: unknown }).fleet = {
    addAgent: vi.fn(async (cfg: Record<string, unknown>) => {
      added.push(cfg);
    }),
  };
  return { svc, added };
}

const project = (over: Record<string, unknown> = {}): Project =>
  ({
    slug: "demo",
    name: "Demo",
    dir: "/tmp/demo",
    workingDir: "/tmp/demo",
    model: "claude-opus-4-8",
    ...over,
  }) as unknown as Project;

describe("HerdctlService.ensureKeeperModel (per-chat model override — #336)", () => {
  it("re-registers the keeper agent at the requested model", async () => {
    const { svc, added } = svcWithFakeFleet();
    await svc.ensureKeeperModel(project(), "claude-sonnet-5");
    const keeper = added.find((c) => c.name === keeperAgentName("demo"));
    expect(keeper).toBeDefined();
    expect(keeper!.model).toBe("claude-sonnet-5");
  });

  it("is idempotent for the same model (a fan-out on one model registers once)", async () => {
    const { svc, added } = svcWithFakeFleet();
    await svc.ensureKeeperModel(project(), "claude-sonnet-5");
    await svc.ensureKeeperModel(project(), "claude-sonnet-5");
    await svc.ensureKeeperModel(project(), "claude-sonnet-5");
    const keeperRegistrations = added.filter((c) => c.name === keeperAgentName("demo"));
    expect(keeperRegistrations).toHaveLength(1);
  });

  it("re-registers again when the model actually changes", async () => {
    const { svc, added } = svcWithFakeFleet();
    await svc.ensureKeeperModel(project(), "claude-sonnet-5");
    await svc.ensureKeeperModel(project(), "claude-haiku-4-5-20251001");
    const models = added.filter((c) => c.name === keeperAgentName("demo")).map((c) => c.model);
    expect(models).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });
});
