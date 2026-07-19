/**
 * ProjectStore trigger persistence (Epic T / T1).
 *
 * `project.yaml` carries a unified `triggers` map (discriminated `trigger` + shared
 * `run` + enabled). These tests cover the round-trip through `normalize` (malformed
 * entries dropped, good ones preserved, trigger-less files unchanged) and the mutation
 * persistence half (`setTrigger` / `removeTrigger`) that T3 (REST + MCP) + T4 (Triggers
 * tab) drive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("ProjectStore triggers", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-triggers-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  const yamlPath = (slug: string) => path.join(root, slug, "project.yaml");
  async function readYaml(slug: string): Promise<Record<string, unknown>> {
    return YAML.parse(await fs.readFile(yamlPath(slug), "utf8"));
  }
  async function writeTriggersRaw(slug: string, triggers: unknown): Promise<void> {
    const parsed = await readYaml(slug);
    parsed.triggers = triggers;
    await fs.writeFile(yamlPath(slug), YAML.stringify(parsed), "utf8");
  }

  it("carries well-formed triggers through normalize, drops malformed", async () => {
    const p = await store.create({ name: "Trig Proj" });
    await writeTriggersRaw(p.slug, {
      daily: {
        trigger: { type: "schedule", cron: "0 9 * * *" },
        run: { promptFile: "daily.md", session: "resume", tools: ["Bash"] },
        enabled: true,
      },
      broken: { trigger: { type: "schedule" }, run: { prompt: "x" } }, // no cron/interval → dropped
      note: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "hi" } },
    });
    const got = await store.get(p.slug);
    expect(Object.keys(got.triggers ?? {}).sort()).toEqual(["daily", "note"]);
    expect(got.triggers?.daily).toEqual({
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { promptFile: "daily.md", session: "resume", tools: ["Bash"] },
      enabled: true,
    });
    // note picks up the safe-create default (enabled:false) + run defaults.
    expect(got.triggers?.note.enabled).toBe(false);
    expect(got.triggers?.note.run.session).toBe("new");
  });

  it("leaves trigger-less files untouched (no empty triggers key)", async () => {
    const p = await store.create({ name: "Plain Proj" });
    expect(await readYaml(p.slug)).not.toHaveProperty("triggers");
    const got = await store.get(p.slug);
    expect(got.triggers).toBeUndefined();
  });

  it("setTrigger persists + validates (rejects a bad discriminant)", async () => {
    const p = await store.create({ name: "Set Proj" });
    const updated = await store.setTrigger(p.slug, "cleanup", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "spin down" },
      enabled: true,
    });
    expect(updated.triggers?.cleanup.trigger).toEqual({ type: "event", on: "onArchive" });
    // Persisted to disk.
    const onDisk = (await readYaml(p.slug)).triggers as Record<string, unknown>;
    expect(onDisk).toHaveProperty("cleanup");

    await expect(
      store.setTrigger(p.slug, "bad", { trigger: { type: "event", on: "unknownEvent" }, run: { prompt: "x" } }),
    ).rejects.toThrow();
    await expect(store.setTrigger(p.slug, "bad name!", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" } })).rejects.toThrow();
  });

  it("removeTrigger drops the entry (and the whole key when last)", async () => {
    const p = await store.create({ name: "Rm Proj" });
    await store.setTrigger(p.slug, "a", { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" } });
    await store.setTrigger(p.slug, "b", { trigger: { type: "schedule", interval: "1h" }, run: { prompt: "y" } });
    await store.removeTrigger(p.slug, "a");
    expect(Object.keys((await store.get(p.slug)).triggers ?? {})).toEqual(["b"]);
    await store.removeTrigger(p.slug, "b");
    expect((await store.get(p.slug)).triggers).toBeUndefined();
    // The key is gone from disk entirely.
    expect(await readYaml(p.slug)).not.toHaveProperty("triggers");
  });
});
