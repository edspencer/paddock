import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueuedMessageStore } from "../../src/queued-message.js";

// Covers the per-chat queued-message sidecar (#197) and the atomic `take` that
// makes server-authoritative draining safe against double-send (#245).
describe("QueuedMessageStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paddock-queued-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores, reads back, and clears a queued message", async () => {
    const store = new QueuedMessageStore(dir);
    expect(await store.get("keeper-a", "s1")).toBeNull();

    await store.set("keeper-a", "s1", { text: "hello", createdAtMs: 111 });
    expect(await store.get("keeper-a", "s1")).toEqual({ text: "hello", createdAtMs: 111 });

    await store.set("keeper-a", "s1", null);
    expect(await store.get("keeper-a", "s1")).toBeNull();
  });

  it("keys separately by (agent, session)", async () => {
    const store = new QueuedMessageStore(dir);
    await store.set("keeper-a", "s1", { text: "A", createdAtMs: 1 });
    await store.set("keeper-b", "s1", { text: "B", createdAtMs: 2 });
    await store.set("keeper-a", "s2", { text: "C", createdAtMs: 3 });
    expect((await store.get("keeper-a", "s1"))?.text).toBe("A");
    expect((await store.get("keeper-b", "s1"))?.text).toBe("B");
    expect((await store.get("keeper-a", "s2"))?.text).toBe("C");
  });

  it("persists across store instances (survives a restart)", async () => {
    await new QueuedMessageStore(dir).set("keeper-a", "s1", { text: "durable", createdAtMs: 9 });
    // A fresh instance reads the same file.
    const reloaded = new QueuedMessageStore(dir);
    expect(await reloaded.get("keeper-a", "s1")).toEqual({ text: "durable", createdAtMs: 9 });
  });

  it("take() returns AND removes the message", async () => {
    const store = new QueuedMessageStore(dir);
    await store.set("keeper-a", "s1", { text: "once", createdAtMs: 5 });
    expect(await store.take("keeper-a", "s1")).toEqual({ text: "once", createdAtMs: 5 });
    // Gone now.
    expect(await store.take("keeper-a", "s1")).toBeNull();
    expect(await store.get("keeper-a", "s1")).toBeNull();
  });

  it("take() is atomic: two concurrent takes never both get the message (#245)", async () => {
    const store = new QueuedMessageStore(dir);
    await store.set("keeper-a", "s1", { text: "solo", createdAtMs: 7 });
    // Fire both without awaiting in between — mimics a completion-drain racing an
    // idle set_queue drain. Exactly one must win.
    const [a, b] = await Promise.all([
      store.take("keeper-a", "s1"),
      store.take("keeper-a", "s1"),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ text: "solo", createdAtMs: 7 });
  });

  it("take() on an empty/missing store is a non-throwing null", async () => {
    const store = new QueuedMessageStore(dir);
    expect(await store.take("keeper-a", "nope")).toBeNull();
  });
});
