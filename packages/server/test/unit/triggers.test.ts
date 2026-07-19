/**
 * TriggerService — the unified trigger CRUD/registry surface (Epic T / T1), the
 * frozen contract T2–T5 build on. Driven against a real {@link ProjectStore} (tmp
 * dir) + a fake HerdctlService recording the arm half, covering the persist-THEN-arm
 * two-step, the DTO shape (name + `trigger-<slug>-<name>` agent), the by-type arming
 * (event → own agent; schedule → keeper re-register), and the read helpers the
 * dispatcher / T3 tools call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProjectStore } from "../../src/projects.js";
import { TriggerService } from "../../src/triggers.js";
import { triggerAgentName, type HerdctlService } from "../../src/herdctl.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("TriggerService (T1 surface consumed by T2–T5)", () => {
  let root: string;
  let store: ProjectStore;
  let armedAgents: Array<{ slug: string; name: string }>;
  let removedAgents: Array<{ slug: string; name: string }>;
  let keeperReregisters: string[];
  let triggers: TriggerService;

  const fakeHerdctl = (): HerdctlService =>
    ({
      ensureTriggerAgent: async (project: { slug: string }, name: string) => {
        armedAgents.push({ slug: project.slug, name });
      },
      removeTriggerAgent: async (slug: string, name: string) => {
        removedAgents.push({ slug, name });
      },
      ensureProjectAgent: async (project: { slug: string }) => {
        keeperReregisters.push(project.slug);
      },
    }) as unknown as HerdctlService;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-trigsvc-");
    store = new ProjectStore(root);
    await store.init();
    armedAgents = [];
    removedAgents = [];
    keeperReregisters = [];
    triggers = new TriggerService(store, fakeHerdctl());
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("set persists an EVENT trigger AND arms its own trigger-<slug>-<name> agent", async () => {
    const p = await store.create({ name: "Trig Proj" });
    const dto = await triggers.set(p.slug, "cleanup", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "spin down servers", tools: ["Bash"], maxTurns: 10 },
      enabled: true,
    });
    expect(dto.name).toBe("cleanup");
    expect(dto.agentName).toBe(triggerAgentName(p.slug, "cleanup"));
    expect(dto.trigger).toEqual({ type: "event", on: "onArchive" });
    expect(dto.enabled).toBe(true);
    expect(dto.run.tools).toEqual(["Bash"]);
    // Armed its OWN agent (event trigger).
    expect(armedAgents).toEqual([{ slug: p.slug, name: "cleanup" }]);
    expect(keeperReregisters).toEqual([]);
    // Persisted to disk (a fresh read sees it).
    const reread = await triggers.get(p.slug, "cleanup");
    expect(reread?.run.prompt).toBe("spin down servers");
  });

  it("set persists a SCHEDULE trigger AND arms via a keeper re-register (not its own agent)", async () => {
    const p = await store.create({ name: "Sched Proj" });
    await triggers.set(p.slug, "daily", {
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { promptFile: "daily.md", session: "resume" },
      enabled: true,
    });
    // Schedule triggers ride the keeper's forwarded schedules block, not an own agent.
    expect(armedAgents).toEqual([]);
    expect(keeperReregisters).toEqual([p.slug]);
  });

  it("defaults enabled:false on programmatic create when omitted", async () => {
    const p = await store.create({ name: "Default Proj" });
    const dto = await triggers.set(p.slug, "t", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "x" },
    });
    expect(dto.enabled).toBe(false);
  });

  it("throws on a malformed trigger (Zod rejects) — nothing persisted", async () => {
    const p = await store.create({ name: "Bad Proj" });
    await expect(
      triggers.set(p.slug, "broken", {
        trigger: { type: "schedule", cron: "0 9 * * *", interval: "1h" },
        run: { prompt: "x" },
      }),
    ).rejects.toThrow();
    expect(await triggers.get(p.slug, "broken")).toBeNull();
  });

  it("list + getByAgentName resolve declared triggers", async () => {
    const p = await store.create({ name: "List Proj" });
    await triggers.set(p.slug, "a", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" } });
    await triggers.set(p.slug, "b", { trigger: { type: "schedule", interval: "1h" }, run: { prompt: "y" } });
    const list = await triggers.list(p.slug);
    expect(list.map((t) => t.name).sort()).toEqual(["a", "b"]);
    const byAgent = await triggers.getByAgentName(p.slug, triggerAgentName(p.slug, "a"));
    expect(byAgent?.name).toBe("a");
    expect(await triggers.getByAgentName(p.slug, "trigger-nope-nope")).toBeNull();
  });

  it("enabledForEvent returns ONLY enabled event triggers matching the event", async () => {
    const p = await store.create({ name: "Event Proj" });
    await triggers.set(p.slug, "on", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" }, enabled: true });
    await triggers.set(p.slug, "off", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" }, enabled: false });
    await triggers.set(p.slug, "after", { trigger: { type: "event", on: "afterTurn" }, run: { prompt: "x" }, enabled: true });
    await triggers.set(p.slug, "sched", { trigger: { type: "schedule", interval: "1h" }, run: { prompt: "x" }, enabled: true });
    const matched = await triggers.enabledForEvent(p.slug, "onArchive");
    expect(matched.map((t) => t.name)).toEqual(["on"]);
  });

  it("remove tears down an event trigger's agent and drops it from disk", async () => {
    const p = await store.create({ name: "Rm Proj" });
    await triggers.set(p.slug, "cleanup", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" }, enabled: true });
    const existed = await triggers.remove(p.slug, "cleanup");
    expect(existed).toBe(true);
    expect(removedAgents).toEqual([{ slug: p.slug, name: "cleanup" }]);
    expect(await triggers.get(p.slug, "cleanup")).toBeNull();
    // Removing an absent one echoes false.
    expect(await triggers.remove(p.slug, "cleanup")).toBe(false);
  });

  it("remove of an UNSCOPED SCHEDULE re-registers the keeper only (no own agent to tear down)", async () => {
    const p = await store.create({ name: "RmSched Proj" });
    await triggers.set(p.slug, "daily", { trigger: { type: "schedule", interval: "1h" }, run: { prompt: "x" }, enabled: true });
    keeperReregisters = [];
    await triggers.remove(p.slug, "daily");
    expect(keeperReregisters).toEqual([p.slug]);
    // An unscoped schedule never registered a `trigger-<slug>-<name>` agent (T2).
    expect(removedAgents).toEqual([]);
  });

  it("remove of a SCOPED SCHEDULE (T2) tears down its own agent AND re-registers the keeper", async () => {
    const p = await store.create({ name: "RmScoped Proj" });
    // A `run.tools` allow-list makes the schedule run on its own scoped agent (T2).
    await triggers.set(p.slug, "reader", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "x", tools: ["Read", "Grep"] },
      enabled: true,
    });
    keeperReregisters = [];
    removedAgents = [];
    await triggers.remove(p.slug, "reader");
    // Both: the scoped agent is torn down AND the keeper drops the forwarded cron entry.
    expect(removedAgents).toEqual([{ slug: p.slug, name: "reader" }]);
    expect(keeperReregisters).toEqual([p.slug]);
    expect(await triggers.get(p.slug, "reader")).toBeNull();
  });
});
