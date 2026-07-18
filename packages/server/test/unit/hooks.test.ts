/**
 * HookService — the shared hook-CRUD surface (Epic G / G1) that the Hooks tab (G4)
 * and the hook-management MCP (G5) both consume. These tests drive the service
 * against a real {@link ProjectStore} (tmp dir) + a fake HerdctlService that records
 * the live-arming half, so they cover the persist-THEN-arm two-step, the DTO shape
 * (name + `hook-<slug>-<name>` agent), and the read helpers G5's tools call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProjectStore } from "../../src/projects.js";
import { HookService } from "../../src/hooks.js";
import { hookAgentName, type HerdctlService } from "../../src/herdctl.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("HookService (G1 surface consumed by G5)", () => {
  let root: string;
  let store: ProjectStore;
  let ensured: Array<{ slug: string; name: string; enabled?: boolean }>;
  let removed: Array<{ slug: string; name: string }>;
  let hooks: HookService;

  const fakeHerdctl = (): HerdctlService =>
    ({
      ensureHookAgent: async (project: { slug: string }, name: string, hook: { enabled?: boolean }) => {
        ensured.push({ slug: project.slug, name, enabled: hook.enabled });
      },
      removeHookAgent: async (slug: string, name: string) => {
        removed.push({ slug, name });
      },
    }) as unknown as HerdctlService;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-hooksvc-");
    store = new ProjectStore(root);
    await store.init();
    ensured = [];
    removed = [];
    hooks = new HookService(store, fakeHerdctl());
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("set persists the hook to project.yaml AND arms its hook-<slug>-<name> agent", async () => {
    const p = await store.create({ name: "Hook Proj" });
    const dto = await hooks.set(p.slug, "cleanup", {
      event: "onArchive",
      prompt: "spin down servers",
      capabilities: { allowedTools: ["Bash"], maxTurns: 10 },
      enabled: true,
    });
    expect(dto.name).toBe("cleanup");
    expect(dto.agentName).toBe(hookAgentName(p.slug, "cleanup"));
    expect(dto.event).toBe("onArchive");
    expect(dto.enabled).toBe(true);
    expect(dto.capabilities).toEqual({ allowedTools: ["Bash"], maxTurns: 10 });
    // Armed the runtime agent…
    expect(ensured).toEqual([{ slug: p.slug, name: "cleanup", enabled: true }]);
    // …and persisted to disk (a fresh read sees it).
    const reread = await hooks.get(p.slug, "cleanup");
    expect(reread?.prompt).toBe("spin down servers");
  });

  it("list returns every declared hook as a DTO; get returns null for an unknown name", async () => {
    const p = await store.create({ name: "Hook Proj" });
    await hooks.set(p.slug, "a", { event: "onArchive", prompt: "x" });
    await hooks.set(p.slug, "b", { event: "onArchive", prompt: "y", enabled: true });
    const list = await hooks.list(p.slug);
    expect(list.map((h) => h.name).sort()).toEqual(["a", "b"]);
    expect(await hooks.get(p.slug, "missing")).toBeNull();
  });

  it("remove deletes the hook + unregisters its agent, echoing whether it existed", async () => {
    const p = await store.create({ name: "Hook Proj" });
    await hooks.set(p.slug, "cleanup", { event: "onArchive", prompt: "x" });
    expect(await hooks.remove(p.slug, "cleanup")).toBe(true);
    expect(removed).toEqual([{ slug: p.slug, name: "cleanup" }]);
    expect(await hooks.get(p.slug, "cleanup")).toBeNull();
    // Idempotent: removing an absent hook reports false.
    expect(await hooks.remove(p.slug, "cleanup")).toBe(false);
  });

  it("set throws on a malformed hook (unknown event) — nothing armed", async () => {
    const p = await store.create({ name: "Hook Proj" });
    await expect(hooks.set(p.slug, "bad", { event: "onNope", prompt: "x" })).rejects.toThrow();
    expect(ensured).toHaveLength(0);
  });

  it("enabledForEvent returns only the enabled hooks for that event", async () => {
    const p = await store.create({ name: "Hook Proj" });
    await hooks.set(p.slug, "on", { event: "onArchive", prompt: "x", enabled: true });
    await hooks.set(p.slug, "off", { event: "onArchive", prompt: "y", enabled: false });
    const fired = await hooks.enabledForEvent(p.slug, "onArchive");
    expect(fired.map((h) => h.name)).toEqual(["on"]);
  });
});
