import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParentDetachStore } from "../../src/parent-detach.js";

/** The store keys by `<agent>\0<sessionId>`; spell the NUL out rather than paste one. */
const key = (agent: string, sessionId: string) => `${agent}\u0000${sessionId}`;

/**
 * ParentDetachStore (#508) — the sidecar backing "detach this chat from its
 * parent". Mirrors archive.test.ts: persistence, keying, and corruption
 * tolerance, plus the two properties detach specifically depends on — that it is
 * an override that can be lifted, and that a load failure degrades to "nothing is
 * detached" rather than flattening the whole tree.
 */
describe("ParentDetachStore (#508)", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "parent-detach.json");

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paddock-detach-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads false for an unknown chat and writes no file", async () => {
    const store = new ParentDetachStore(dir);
    expect(await store.isDetached("keeper-p", "s1")).toBe(false);
    await expect(fs.access(stateFile())).rejects.toThrow();
  });

  it("persists a detach and reloads it in a fresh store", async () => {
    const store = new ParentDetachStore(dir);
    expect(await store.setDetached("keeper-p", "s1", true)).toBe(true);

    const reloaded = new ParentDetachStore(dir);
    expect(await reloaded.isDetached("keeper-p", "s1")).toBe(true);
  });

  it("re-attaches by clearing the flag — nothing was destroyed", async () => {
    const store = new ParentDetachStore(dir);
    await store.setDetached("keeper-p", "s1", true);
    expect(await store.setDetached("keeper-p", "s1", false)).toBe(true);
    expect(await store.isDetached("keeper-p", "s1")).toBe(false);
    // The key is gone from the file, not merely flipped — the sidecar stays compact.
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual([]);
  });

  it("is idempotent — a repeat set reports no change", async () => {
    const store = new ParentDetachStore(dir);
    expect(await store.setDetached("keeper-p", "s1", true)).toBe(true);
    expect(await store.setDetached("keeper-p", "s1", true)).toBe(false);
    expect(await store.setDetached("keeper-p", "s2", false)).toBe(false);
  });

  it("keys by (agent, session) so two projects' chats can't collide", async () => {
    const store = new ParentDetachStore(dir);
    await store.setDetached("keeper-a", "same-id", true);
    expect(await store.isDetached("keeper-a", "same-id")).toBe(true);
    expect(await store.isDetached("keeper-b", "same-id")).toBe(false);
  });

  it("degrades to 'nothing detached' on a corrupt sidecar", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    const store = new ParentDetachStore(dir);
    // A corrupt file must not detach every chat (which would flatten the tree)…
    expect(await store.isDetached("keeper-p", "s1")).toBe(false);
    // …and the store still accepts writes, rebuilding the file from empty.
    await store.setDetached("keeper-p", "s1", true);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual([key("keeper-p", "s1")]);
  });

  it("survives concurrent toggles without losing a key", async () => {
    const store = new ParentDetachStore(dir);
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => store.setDetached("keeper-p", id, true)));
    const persisted = JSON.parse(await fs.readFile(stateFile(), "utf8")) as string[];
    expect(persisted.sort()).toEqual(ids.map((id) => key("keeper-p", id)).sort());
  });
});
