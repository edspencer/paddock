/**
 * ProjectStore schedule persistence (issue #265 / DD-2).
 *
 * `project.yaml` carries a `schedules` map in herdctl's `ScheduleSchema` shape
 * (+ Paddock-only `promptFile`). These tests cover the round-trip through
 * `normalize` (malformed entries dropped, good ones preserved) and the runtime
 * mutation persistence half (`setSchedule` / `removeSchedule`) the D4 UI drives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("ProjectStore schedules", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-sched-");
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
  async function writeSchedulesRaw(slug: string, schedules: unknown): Promise<void> {
    const parsed = await readYaml(slug);
    parsed.schedules = schedules;
    await fs.writeFile(yamlPath(slug), YAML.stringify(parsed), "utf8");
  }

  it("carries well-formed schedules through normalize, drops malformed", async () => {
    const p = await store.create({ name: "Sched Proj" });
    await writeSchedulesRaw(p.slug, {
      daily: { type: "cron", cron: "0 9 * * *", prompt: "triage", resume_session: true },
      broken: { type: "cron" }, // no cron → dropped
      ticker: { type: "interval", interval: "15m", promptFile: "tick.md" },
    });
    const got = await store.get(p.slug);
    expect(Object.keys(got.schedules ?? {}).sort()).toEqual(["daily", "ticker"]);
    expect(got.schedules?.daily).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      prompt: "triage",
      resume_session: true,
    });
    expect(got.schedules?.ticker).toEqual({
      type: "interval",
      interval: "15m",
      promptFile: "tick.md",
    });
  });

  it("setSchedule persists a new/updated schedule to project.yaml", async () => {
    const p = await store.create({ name: "Mutate Me" });
    const updated = await store.setSchedule(p.slug, "hourly", {
      type: "interval",
      interval: "1h",
      prompt: "hello",
    });
    expect(updated.schedules?.hourly).toEqual({ type: "interval", interval: "1h", prompt: "hello" });
    // Durable on disk.
    expect((await readYaml(p.slug)).schedules).toMatchObject({
      hourly: { type: "interval", interval: "1h", prompt: "hello" },
    });
    // Replace the same key.
    const replaced = await store.setSchedule(p.slug, "hourly", { type: "cron", cron: "@daily" });
    expect(replaced.schedules?.hourly).toEqual({ type: "cron", cron: "@daily" });
  });

  it("setSchedule rejects a malformed schedule / bad name", async () => {
    const p = await store.create({ name: "Reject" });
    await expect(store.setSchedule(p.slug, "x", { type: "cron" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      store.setSchedule(p.slug, "bad name", { type: "interval", interval: "5m" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("removeSchedule deletes one and drops the key entirely when empty", async () => {
    const p = await store.create({ name: "Remove" });
    await store.setSchedule(p.slug, "a", { type: "interval", interval: "5m" });
    await store.setSchedule(p.slug, "b", { type: "interval", interval: "10m" });

    const afterOne = await store.removeSchedule(p.slug, "a");
    expect(Object.keys(afterOne.schedules ?? {})).toEqual(["b"]);

    const afterAll = await store.removeSchedule(p.slug, "b");
    expect(afterAll.schedules).toBeUndefined();
    // The key is gone from disk (not persisted as an empty map).
    expect(await readYaml(p.slug)).not.toHaveProperty("schedules");
  });

  it("removeSchedule is a no-op for an unknown name", async () => {
    const p = await store.create({ name: "Noop" });
    const same = await store.removeSchedule(p.slug, "nope");
    expect(same.schedules).toBeUndefined();
  });
});
