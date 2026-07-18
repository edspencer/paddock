/**
 * ProjectStore hook persistence (Epic G / G1).
 *
 * `project.yaml` carries a `hooks` map (event + capabilities + prompt/promptFile +
 * enabled). These tests cover the round-trip through `normalize` (malformed entries
 * dropped, good ones preserved, hook-less files unchanged) and the mutation
 * persistence half (`setHook` / `removeHook`) the Hooks tab (G4) + hook MCP (G5) drive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("ProjectStore hooks", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-hooks-");
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
  async function writeHooksRaw(slug: string, hooks: unknown): Promise<void> {
    const parsed = await readYaml(slug);
    parsed.hooks = hooks;
    await fs.writeFile(yamlPath(slug), YAML.stringify(parsed), "utf8");
  }

  it("carries well-formed hooks through normalize, drops malformed", async () => {
    const p = await store.create({ name: "Hook Proj" });
    await writeHooksRaw(p.slug, {
      cleanup: {
        event: "onArchive",
        capabilities: { allowedTools: ["Bash"], maxTurns: 10 },
        promptFile: "cleanup.md",
        enabled: true,
      },
      broken: { event: "nope" }, // unknown event → dropped
      note: { event: "onArchive", prompt: "hi" },
    });
    const got = await store.get(p.slug);
    expect(Object.keys(got.hooks ?? {}).sort()).toEqual(["cleanup", "note"]);
    expect(got.hooks?.cleanup).toEqual({
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"], maxTurns: 10 },
      promptFile: "cleanup.md",
      enabled: true,
    });
  });

  it("a hook-less project round-trips with no hooks key on disk", async () => {
    const p = await store.create({ name: "No Hooks" });
    expect((await store.get(p.slug)).hooks).toBeUndefined();
    expect(await readYaml(p.slug)).not.toHaveProperty("hooks");
  });

  it("setHook persists a new/updated hook (defaults nothing — enabled stays absent)", async () => {
    const p = await store.create({ name: "Mutate Me" });
    const updated = await store.setHook(p.slug, "cleanup", {
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"] },
      promptFile: "cleanup.md",
    });
    expect(updated.hooks?.cleanup).toEqual({
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"] },
      promptFile: "cleanup.md",
    });
    // Durable on disk.
    expect((await readYaml(p.slug)).hooks).toMatchObject({
      cleanup: { event: "onArchive", promptFile: "cleanup.md" },
    });
    // Replace the same key — flip it enabled.
    const replaced = await store.setHook(p.slug, "cleanup", {
      event: "onArchive",
      prompt: "just note it",
      enabled: true,
    });
    expect(replaced.hooks?.cleanup).toEqual({
      event: "onArchive",
      prompt: "just note it",
      enabled: true,
    });
  });

  it("setHook rejects a malformed hook / bad name", async () => {
    const p = await store.create({ name: "Reject" });
    await expect(store.setHook(p.slug, "x", { event: "nope" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      store.setHook(p.slug, "bad name", { event: "onArchive" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("removeHook deletes one and drops the key entirely when empty", async () => {
    const p = await store.create({ name: "Remove" });
    await store.setHook(p.slug, "a", { event: "onArchive", prompt: "a" });
    await store.setHook(p.slug, "b", { event: "onArchive", prompt: "b" });

    const afterOne = await store.removeHook(p.slug, "a");
    expect(Object.keys(afterOne.hooks ?? {})).toEqual(["b"]);

    const afterAll = await store.removeHook(p.slug, "b");
    expect(afterAll.hooks).toBeUndefined();
    expect(await readYaml(p.slug)).not.toHaveProperty("hooks");
  });

  it("removeHook is a no-op for an unknown name", async () => {
    const p = await store.create({ name: "Noop" });
    const same = await store.removeHook(p.slug, "nope");
    expect(same.hooks).toBeUndefined();
  });
});
