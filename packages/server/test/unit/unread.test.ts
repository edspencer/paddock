import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { UnreadStore } from "../../src/unread.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the manual-unread sidecar (#458): defaults, toggling,
 * persistence across restarts, PER-USER keying (the store keys by user like
 * read-state, unlike the shared star/archive stores), and tolerance of a
 * missing/corrupt state file. Mirrors the StarStore tests — same JSON-array
 * pattern, but user-keyed.
 */
describe("UnreadStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "unread-state.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-unread-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("defaults to not-unread and writes no file until something is flagged", async () => {
    const store = new UnreadStore(dir);
    expect(await store.isUnread("alice", "keeper-a", "s1")).toBe(false);
    await expect(fs.access(stateFile())).rejects.toBeTruthy(); // no needless write
  });

  it("flags, persists, and clears a chat's manual-unread override", async () => {
    const store = new UnreadStore(dir);
    expect(await store.setUnread("alice", "keeper-a", "s1", true)).toBe(true); // changed
    expect(await store.isUnread("alice", "keeper-a", "s1")).toBe(true);

    // Persisted to disk as a JSON array of keys.
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8")) as string[];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(1);

    // A redundant re-flag is a no-op that reports no change.
    expect(await store.setUnread("alice", "keeper-a", "s1", true)).toBe(false);

    await store.setUnread("alice", "keeper-a", "s1", false);
    expect(await store.isUnread("alice", "keeper-a", "s1")).toBe(false);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual([]);
  });

  it("keys PER USER — one user's unread flag is invisible to another", async () => {
    const store = new UnreadStore(dir);
    await store.setUnread("alice", "keeper-a", "s1", true);
    expect(await store.isUnread("alice", "keeper-a", "s1")).toBe(true);
    expect(await store.isUnread("bob", "keeper-a", "s1")).toBe(false);
    // The anonymous/shared bucket (null user) is likewise distinct.
    expect(await store.isUnread(null, "keeper-a", "s1")).toBe(false);
  });

  it("keys by (agent, session) so different agents don't collide", async () => {
    const store = new UnreadStore(dir);
    await store.setUnread(null, "keeper-a", "same", true);
    expect(await store.isUnread(null, "keeper-a", "same")).toBe(true);
    expect(await store.isUnread(null, "keeper-other", "same")).toBe(false);
  });

  it("does not lose an entry when concurrent toggles race before the first load resolves", async () => {
    // Pre-seed the file so ensureLoaded performs a real async read (the race
    // window the cached load-promise guards). Keys are NUL-separated; build the
    // separator from a char code so this source file stays plain ASCII.
    const nul = String.fromCharCode(0);
    const preKey = ["alice", "keeper-a", "pre"].join(nul);
    await fs.writeFile(stateFile(), JSON.stringify([preKey]), "utf8");
    const store = new UnreadStore(dir);
    await Promise.all([
      store.setUnread("alice", "keeper-a", "a", true),
      store.setUnread("alice", "keeper-a", "b", true),
    ]);
    const reopened = new UnreadStore(dir);
    expect(await reopened.isUnread("alice", "keeper-a", "pre")).toBe(true);
    expect(await reopened.isUnread("alice", "keeper-a", "a")).toBe(true);
    expect(await reopened.isUnread("alice", "keeper-a", "b")).toBe(true);
  });

  it("survives a restart (a fresh store reads the persisted flag)", async () => {
    await new UnreadStore(dir).setUnread("alice", "keeper-a", "s1", true);
    const reopened = new UnreadStore(dir);
    expect(await reopened.isUnread("alice", "keeper-a", "s1")).toBe(true);
    expect(await reopened.isUnread("alice", "keeper-a", "s2")).toBe(false);
  });

  it("tolerates a corrupt state file (reads as empty)", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    const store = new UnreadStore(dir);
    expect(await store.isUnread("alice", "keeper-a", "s1")).toBe(false);
    await store.setUnread("alice", "keeper-a", "s1", true);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toHaveLength(1);
  });
});
