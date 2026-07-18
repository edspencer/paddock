/**
 * In-process lifecycle event bus (Epic G / G1).
 *
 * The two invariants that make it safe as the hook foundation: `emit` is
 * fire-and-forget (never blocks or throws into the caller — so a buggy hook can't
 * break the archive that triggered it), and listeners are typed per event.
 */
import { describe, it, expect } from "vitest";
import { PaddockEventBus } from "../../src/event-bus.js";

/** Resolve on the next macrotask so fire-and-forget listeners have run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PaddockEventBus", () => {
  it("delivers an emitted event to a subscribed listener", async () => {
    const bus = new PaddockEventBus();
    const seen: { slug: string; sessionId: string }[] = [];
    bus.on("onArchive", (p) => {
      seen.push(p);
    });
    bus.emit("onArchive", { slug: "proj", sessionId: "abc" });
    await tick();
    expect(seen).toEqual([{ slug: "proj", sessionId: "abc" }]);
  });

  it("fans out to every listener", async () => {
    const bus = new PaddockEventBus();
    let a = 0;
    let b = 0;
    bus.on("onArchive", () => {
      a++;
    });
    bus.on("onArchive", () => {
      b++;
    });
    bus.emit("onArchive", { slug: "p", sessionId: "s" });
    await tick();
    expect([a, b]).toEqual([1, 1]);
  });

  it("emit is a no-op with no listeners", () => {
    const bus = new PaddockEventBus();
    expect(() => bus.emit("onArchive", { slug: "p", sessionId: "s" })).not.toThrow();
  });

  it("NEVER throws into the caller when a listener throws synchronously", async () => {
    const bus = new PaddockEventBus();
    let good = 0;
    bus.on("onArchive", () => {
      throw new Error("boom");
    });
    bus.on("onArchive", () => {
      good++; // a later listener still runs — the throwing one is isolated
    });
    // The whole point: the archiver calling emit must not see the throw.
    expect(() => bus.emit("onArchive", { slug: "p", sessionId: "s" })).not.toThrow();
    await tick();
    expect(good).toBe(1);
  });

  it("swallows an async listener rejection", async () => {
    const bus = new PaddockEventBus();
    let ran = false;
    bus.on("onArchive", async () => {
      ran = true;
      throw new Error("async boom");
    });
    bus.emit("onArchive", { slug: "p", sessionId: "s" });
    await tick();
    await tick();
    expect(ran).toBe(true); // and no unhandled rejection blew up the test
  });

  it("unsubscribe stops further delivery", async () => {
    const bus = new PaddockEventBus();
    let n = 0;
    const off = bus.on("onArchive", () => {
      n++;
    });
    bus.emit("onArchive", { slug: "p", sessionId: "s" });
    await tick();
    off();
    bus.emit("onArchive", { slug: "p", sessionId: "s" });
    await tick();
    expect(n).toBe(1);
  });
});
