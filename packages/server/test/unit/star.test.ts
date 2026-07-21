import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StarStore } from "../../src/star.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the sidecar star store (#373): defaults, toggling,
 * persistence across restarts, agent/session key isolation, and tolerance of a
 * missing/corrupt state file. A near-verbatim mirror of the ArchiveStore tests
 * (the two stores are the same pattern, orthogonal flags).
 */
describe("StarStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "star-state.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-star-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("defaults to not-starred and no file is written until something is starred", async () => {
    const store = new StarStore(dir);
    expect(await store.isStarred("keeper-a", "s1")).toBe(false);
    await expect(fs.access(stateFile())).rejects.toBeTruthy(); // no needless write
  });

  it("stars, persists, and unstars a chat", async () => {
    const store = new StarStore(dir);
    expect(await store.setStarred("keeper-a", "s1", true)).toBe(true); // changed
    expect(await store.isStarred("keeper-a", "s1")).toBe(true);

    // Persisted to disk as a JSON array of keys.
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8")) as string[];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(1);

    // A redundant re-star is a no-op that reports no change.
    expect(await store.setStarred("keeper-a", "s1", true)).toBe(false);

    await store.setStarred("keeper-a", "s1", false);
    expect(await store.isStarred("keeper-a", "s1")).toBe(false);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual([]);
  });

  it("does not lose an entry when concurrent toggles race before the first load resolves", async () => {
    // Pre-seed the file so ensureLoaded performs a real async read (the race
    // window the cached load-promise guards). Keys are NUL-separated; build the
    // separator from a char code so this source file stays plain ASCII.
    const preKey = ["keeper-a", "pre"].join(String.fromCharCode(0));
    await fs.writeFile(stateFile(), JSON.stringify([preKey]), "utf8");
    const store = new StarStore(dir);
    await Promise.all([
      store.setStarred("keeper-a", "a", true),
      store.setStarred("keeper-a", "b", true),
    ]);
    const reopened = new StarStore(dir);
    expect(await reopened.isStarred("keeper-a", "pre")).toBe(true);
    expect(await reopened.isStarred("keeper-a", "a")).toBe(true);
    expect(await reopened.isStarred("keeper-a", "b")).toBe(true);
  });

  it("survives a restart (a fresh store reads the persisted flag)", async () => {
    await new StarStore(dir).setStarred("keeper-a", "s1", true);
    const reopened = new StarStore(dir);
    expect(await reopened.isStarred("keeper-a", "s1")).toBe(true);
    expect(await reopened.isStarred("keeper-a", "s2")).toBe(false);
  });

  it("keys by (agent, session) so different agents don't collide", async () => {
    const store = new StarStore(dir);
    await store.setStarred("keeper-a", "same", true);
    expect(await store.isStarred("keeper-a", "same")).toBe(true);
    expect(await store.isStarred("scratch", "same")).toBe(false);
  });

  it("tolerates a corrupt state file (reads as empty)", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    const store = new StarStore(dir);
    expect(await store.isStarred("keeper-a", "s1")).toBe(false);
    await store.setStarred("keeper-a", "s1", true);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toHaveLength(1);
  });
});
