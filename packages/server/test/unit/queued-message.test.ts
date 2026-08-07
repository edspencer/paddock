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

  // --- the single slot, shared by every client on the chat (#629) -----------
  //
  // `upsert` decides between "this client can see the slot, so its text IS the
  // slot" and "this client queued without knowing what was already there" from the
  // id it wrote under: the slot's current VERSION, or anything else.
  describe("upsert: one slot, many clients (#629)", () => {
    /** Deterministic version ids so the assertions can name them. */
    function versions() {
      let n = 0;
      return () => `v${++n}`;
    }

    it("a fresh slot takes the client's text and gets a version", async () => {
      const store = new QueuedMessageStore(dir);
      const next = await store.upsert("keeper-a", "s1", { id: "tab-a", text: "x" }, 100, versions());
      expect(next).toMatchObject({ text: "x", createdAtMs: 100, id: "v1" });
      // Both identities are remembered: what the client sent, and what it will hold
      // once it adopts the broadcast version.
      expect(next?.parts).toEqual([
        { id: "tab-a", text: "x" },
        { id: "v1", text: "x" },
      ]);
    });

    it("the same client appending REPLACES the slot (it can see what's in it)", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "x" }, 100, mint);
      // The pane adopted version v1 and now holds "x\ny".
      const next = await store.upsert("keeper-a", "s1", { id: "v1", text: "x\ny" }, 200, mint);
      expect(next?.text).toBe("x\ny");
      // The slot keeps its original age, not the edit's.
      expect(next?.createdAtMs).toBe(100);
    });

    it("a SECOND client's queue is appended, not dropped on the floor", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "from tab A" }, 100, mint);
      const next = await store.upsert("keeper-a", "s1", { id: "tab-b", text: "from tab B" }, 101, mint);
      // Pre-#629 this was a bare `set`: "from tab A" was gone from the store, from
      // tab A's chip, and from localStorage, with no error anywhere.
      expect(next?.text).toBe("from tab A\nfrom tab B");
    });

    it("once both clients see the merge, either can edit it without duplicating the other", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A" }, 100, mint);
      const merged = await store.upsert("keeper-a", "s1", { id: "tab-b", text: "B" }, 101, mint);
      expect(merged?.text).toBe("A\nB");

      // Both panes now render "A\nB" and hold the broadcast version. Tab A appends
      // to what it can SEE, so its text is the whole slot — replace, don't append,
      // or "B" would be re-appended behind it.
      const after = await store.upsert(
        "keeper-a",
        "s1",
        { id: merged!.id!, text: "A\nB\nC" },
        102,
        mint,
      );
      expect(after?.text).toBe("A\nB\nC");
    });

    it("a re-assert of text the slot already knows is a no-op (a reconnect can't duplicate)", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A" }, 100, mint);
      const merged = await store.upsert("keeper-a", "s1", { id: "tab-b", text: "B" }, 101, mint);
      expect(merged?.text).toBe("A\nB");

      // Tab A drops its socket, misses the merge broadcast, reconnects and pushes
      // its stored copy — under its own stale identity. Appending it again would
      // give "A\nB\nA".
      const after = await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A" }, 102, mint);
      expect(after?.text).toBe("A\nB");
    });

    it("a client APPENDING without the current version extends its own text in place", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A" }, 100, mint);
      // The composer keeps ONE queue id across an append (#245) and an older client
      // sends only its enqueue ts, so neither ever carries the slot version — and
      // even a current client can append faster than the broadcast round trip.
      // Appending this as a second contribution would give "A\nA\nB".
      const next = await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A\nB" }, 101, mint);
      expect(next?.text).toBe("A\nB");
    });

    it("...and still doesn't clobber the OTHER client's text while doing it", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A" }, 100, mint);
      await store.upsert("keeper-a", "s1", { id: "tab-b", text: "B" }, 101, mint);
      // Tab A never saw the merge and appends to what it still thinks is the queue.
      // Its line goes where its text already is; tab B's is left alone.
      const next = await store.upsert("keeper-a", "s1", { id: "tab-a", text: "A\nC" }, 102, mint);
      expect(next?.text).toBe("A\nC\nB");
    });

    it("bounds the identities one slot remembers", async () => {
      const store = new QueuedMessageStore(dir);
      const mint = versions();
      for (let i = 0; i < 40; i++) {
        await store.upsert("keeper-a", "s1", { id: `tab-${i}`, text: `m${i}` }, 100 + i, mint);
      }
      // Two identities per write, capped — the sidecar entry can't grow forever.
      expect((await store.get("keeper-a", "s1"))?.parts?.length).toBeLessThanOrEqual(24);
    });

    it("reads an entry written by an older server (no id, no parts)", async () => {
      const store = new QueuedMessageStore(dir);
      await store.set("keeper-a", "s1", { text: "legacy", createdAtMs: 5 });
      const next = await store.upsert("keeper-a", "s1", { id: "tab-b", text: "new" }, 6, versions());
      // The legacy entry has no version, so the incoming id can't match one: its
      // text is merged in rather than replacing what is already queued.
      expect(next?.text).toBe("legacy\nnew");
    });
  });
});