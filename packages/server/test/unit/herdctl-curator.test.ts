/**
 * HerdctlService — the curator (afterTurn) trigger's agent-registration behaviour
 * (Epic T / T5, the folded-in sweeper).
 *
 * Two invariants the fold-in relies on, driven against a real HerdctlService with a
 * fake fleet recording `addAgent`:
 *
 *  1. A `curate-overview` (event/afterTurn) trigger registers NO scoped
 *     `trigger-<slug>-<name>` agent — the curator is executed by SweepService via the
 *     `sweeper-<slug>` agent, so a scoped agent would be dead weight (never fired).
 *     A NORMAL event trigger still registers its own agent (unchanged).
 *  2. A declared curator trigger's `run.model` becomes the `sweeper-<slug>` agent's
 *     model (design §2.1 #4) — herdctl's per-fire trigger API has no model override, so
 *     the per-project sweeper agent carries it. Absent ⇒ the cheap curation default.
 */
import { describe, it, expect, vi } from "vitest";
import {
  HerdctlService,
  triggerAgentName,
  sweeperAgentName,
  SWEEPER_MODEL,
} from "../../src/herdctl.js";
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

const project = (triggers?: Record<string, unknown>): Project =>
  ({
    slug: "demo",
    name: "Demo",
    dir: "/tmp/demo",
    workingDir: "/tmp/demo",
    ...(triggers ? { triggers } : {}),
  }) as unknown as Project;

const curator = (over: Record<string, unknown> = {}) => ({
  trigger: { type: "event", on: "afterTurn" },
  run: { session: "new", tools: [], ...over },
  enabled: true,
});

describe("HerdctlService: curator (afterTurn) trigger agent registration (T5)", () => {
  it("SKIPS registering a scoped agent for the curate-overview trigger", async () => {
    const { svc, added } = svcWithFakeFleet();
    await svc.registerTriggerAgents(
      project({
        "curate-overview": curator(),
        cleanup: {
          trigger: { type: "event", on: "onArchive" },
          run: { session: "new", tools: ["Bash"] },
          enabled: true,
        },
      }),
    );
    const names = added.map((c) => c.name);
    // The NORMAL event trigger registers its own agent…
    expect(names).toContain(triggerAgentName("demo", "cleanup"));
    // …but the curator does NOT (SweepService runs it via the sweeper agent).
    expect(names).not.toContain(triggerAgentName("demo", "curate-overview"));
  });

  it("ensureTriggerAgent is a no-op for a curator trigger", async () => {
    const { svc, added } = svcWithFakeFleet();
    await svc.ensureTriggerAgent(project(), "curate-overview", curator() as never);
    expect(added).toEqual([]);
  });

  it("sweeperAgentConfig honors the curate-overview trigger's run.model", () => {
    const { svc } = svcWithFakeFleet();
    const cfg = (
      svc as unknown as { sweeperAgentConfig(p: Project): Record<string, unknown> }
    ).sweeperAgentConfig(project({ "curate-overview": curator({ model: "claude-opus-4-8" }) }));
    expect(cfg.name).toBe(sweeperAgentName("demo"));
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.allowed_tools).toEqual([]); // still tool-less
  });

  it("sweeperAgentConfig falls back to the default curation model when no curator model", () => {
    const { svc } = svcWithFakeFleet();
    const cfg = (
      svc as unknown as { sweeperAgentConfig(p: Project): Record<string, unknown> }
    ).sweeperAgentConfig(project());
    expect(cfg.model).toBe(SWEEPER_MODEL);
  });
});
