import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ArchiveStore } from "../../src/archive.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the sidecar archive store (#95): defaults, toggling,
 * persistence across restarts, agent/session key isolation, and tolerance of a
 * missing/corrupt state file.
 */
describe("ArchiveStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "archive-state.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-archive-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("defaults to not-archived and no file is written until something is archived", async () => {
    const store = new ArchiveStore(dir);
    expect(await store.isArchived("keeper-a", "s1")).toBe(false);
    await expect(fs.access(stateFile())).rejects.toBeTruthy(); // no needless write
  });

  it("archives, persists, and unarchives a chat", async () => {
    const store = new ArchiveStore(dir);
    await store.setArchived("keeper-a", "s1", true);
    expect(await store.isArchived("keeper-a", "s1")).toBe(true);

    // Persisted to disk as a JSON array of keys.
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8")) as string[];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(1);

    await store.setArchived("keeper-a", "s1", false);
    expect(await store.isArchived("keeper-a", "s1")).toBe(false);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual([]);
  });

  it("survives a restart (a fresh store reads the persisted flag)", async () => {
    await new ArchiveStore(dir).setArchived("keeper-a", "s1", true);
    const reopened = new ArchiveStore(dir);
    expect(await reopened.isArchived("keeper-a", "s1")).toBe(true);
    expect(await reopened.isArchived("keeper-a", "s2")).toBe(false);
  });

  it("keys by (agent, session) so different agents don't collide", async () => {
    const store = new ArchiveStore(dir);
    await store.setArchived("keeper-a", "same", true);
    expect(await store.isArchived("keeper-a", "same")).toBe(true);
    expect(await store.isArchived("scratch", "same")).toBe(false);
  });

  it("tolerates a corrupt state file (reads as empty)", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    const store = new ArchiveStore(dir);
    expect(await store.isArchived("keeper-a", "s1")).toBe(false);
    // A subsequent write recovers the file to valid JSON.
    await store.setArchived("keeper-a", "s1", true);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toHaveLength(1);
  });
});
