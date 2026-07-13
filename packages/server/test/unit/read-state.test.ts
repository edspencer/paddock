import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ReadStateStore, keyOf } from "../../src/read-state.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the server-side read-state sidecar (#189): the shared vs
 * user-keyed key scheme (no collision), set/get round-trips, the monotonic
 * advance rule, tolerance of a missing/corrupt file, persistence across reload,
 * and per-user isolation (user A / user B / the shared bucket are all distinct).
 */
describe("ReadStateStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "read-state.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-readstate-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("keyOf: a shared (null-user) key never collides with a user-keyed one", () => {
    const shared = keyOf(null, "keeper-a", "s1");
    const alice = keyOf("alice", "keeper-a", "s1");
    const bob = keyOf("bob", "keeper-a", "s1");
    expect(shared).not.toBe(alice);
    expect(alice).not.toBe(bob);
    // The shared key has NO user segment (2 fields); the user key has 3.
    expect(shared.split("\u0000")).toHaveLength(2);
    expect(alice.split("\u0000")).toHaveLength(3);
  });

  it("defaults to 0 and writes no file until something is marked seen", async () => {
    const store = new ReadStateStore(dir);
    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(0);
    await expect(fs.access(stateFile())).rejects.toBeTruthy(); // no needless write
  });

  it("round-trips a set/get and persists as a JSON object (not an array)", async () => {
    const store = new ReadStateStore(dir);
    await store.setLastSeen(null, "keeper-a", "s1", 1000);
    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(1000);

    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toEqual({ [keyOf(null, "keeper-a", "s1")]: 1000 });
  });

  it("is monotonic: a newer time advances, an older/equal one is a no-op", async () => {
    const store = new ReadStateStore(dir);
    await store.setLastSeen(null, "keeper-a", "s1", 1000);
    await store.setLastSeen(null, "keeper-a", "s1", 2000); // advances
    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(2000);
    await store.setLastSeen(null, "keeper-a", "s1", 500); // ignored (older)
    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(2000);
    await store.setLastSeen(null, "keeper-a", "s1", 2000); // ignored (equal)
    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(2000);
  });

  it("keeps the shared bucket and per-user read-state independent", async () => {
    const store = new ReadStateStore(dir);
    await store.setLastSeen(null, "keeper-a", "s1", 100); // shared
    await store.setLastSeen("alice", "keeper-a", "s1", 200); // user A
    await store.setLastSeen("bob", "keeper-a", "s1", 300); // user B

    expect(await store.getLastSeen(null, "keeper-a", "s1")).toBe(100);
    expect(await store.getLastSeen("alice", "keeper-a", "s1")).toBe(200);
    expect(await store.getLastSeen("bob", "keeper-a", "s1")).toBe(300);
    // A user with no entry falls back to 0 — NOT the shared bucket.
    expect(await store.getLastSeen("carol", "keeper-a", "s1")).toBe(0);
  });

  it("keys by agent so a project chat and a scratch chat can't collide", async () => {
    const store = new ReadStateStore(dir);
    await store.setLastSeen(null, "keeper-a", "same", 111);
    expect(await store.getLastSeen(null, "keeper-a", "same")).toBe(111);
    expect(await store.getLastSeen(null, "scratch", "same")).toBe(0);
  });

  it("survives a reload (a fresh store reads the persisted map)", async () => {
    await new ReadStateStore(dir).setLastSeen("alice", "keeper-a", "s1", 4242);
    const reopened = new ReadStateStore(dir);
    expect(await reopened.getLastSeen("alice", "keeper-a", "s1")).toBe(4242);
    expect(await reopened.getLastSeen("alice", "keeper-a", "s2")).toBe(0);
    expect(await reopened.getLastSeen(null, "keeper-a", "s1")).toBe(0);
  });

  it("tolerates a corrupt / non-object state file (reads as 0)", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    expect(await new ReadStateStore(dir).getLastSeen(null, "keeper-a", "s1")).toBe(0);
    // An array (wrong shape) is also ignored.
    await fs.writeFile(stateFile(), "[1,2,3]", "utf8");
    expect(await new ReadStateStore(dir).getLastSeen(null, "keeper-a", "s1")).toBe(0);
  });
});
