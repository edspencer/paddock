import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  RunProvenanceStore,
  childOf,
  HUMAN_ROOT,
  SCHEDULED_ROOT,
  type RunProvenance,
} from "../../src/run-provenance.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the turn-provenance marker (issue #261 / A1): the pure
 * origin/depth helpers (esp. that a spawned child carries depth = parent+1 and
 * origin = spawned — the property #262 depth-gates and #267 badges), and the
 * sidecar store's stamp/get round-trip, its create-once semantics
 * (stampIfAbsent never clobbers), reload persistence, and tolerance of a
 * missing/corrupt/malformed file.
 */
describe("run provenance — pure markers", () => {
  it("HUMAN_ROOT / SCHEDULED_ROOT are depth-0 roots with the right origin", () => {
    expect(HUMAN_ROOT).toEqual({ origin: "human", depth: 0 });
    expect(SCHEDULED_ROOT).toEqual({ origin: "scheduled", depth: 0 });
  });

  it("childOf: a spawned child is origin=spawned, depth = parent.depth + 1", () => {
    // A human turn (depth 0) spawning a child → depth 1, origin spawned.
    expect(childOf(HUMAN_ROOT)).toEqual({ origin: "spawned", depth: 1 });
    // A scheduled root (depth 0) spawning → depth 1, origin spawned.
    expect(childOf(SCHEDULED_ROOT)).toEqual({ origin: "spawned", depth: 1 });
  });

  it("childOf composes: each spawn hop deepens by exactly one (grandchildren)", () => {
    const child = childOf(HUMAN_ROOT); // depth 1
    const grandchild = childOf(child); // depth 2
    const greatGrandchild = childOf(grandchild); // depth 3
    expect(child.depth).toBe(1);
    expect(grandchild).toEqual({ origin: "spawned", depth: 2 });
    expect(greatGrandchild).toEqual({ origin: "spawned", depth: 3 });
    // The origin stays spawned all the way down; only depth grows.
    expect([child, grandchild, greatGrandchild].every((p) => p.origin === "spawned")).toBe(true);
  });
});

describe("RunProvenanceStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "run-provenance.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-provenance-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("returns undefined and writes no file until something is stamped", async () => {
    const store = new RunProvenanceStore(dir);
    expect(await store.get("sess-1")).toBeUndefined();
    await expect(fs.access(stateFile())).rejects.toBeTruthy();
  });

  it("stamps a spawned child at depth 1 and round-trips it (the A1 property)", async () => {
    const store = new RunProvenanceStore(dir);
    const child = childOf(HUMAN_ROOT);
    await store.stamp("child-sid", child);
    expect(await store.get("child-sid")).toEqual({ origin: "spawned", depth: 1 });

    // Persisted as a plain JSON object keyed by session id (not an array).
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toEqual({ "child-sid": { origin: "spawned", depth: 1 } });
  });

  it("stamp overwrites an existing marker (last write wins)", async () => {
    const store = new RunProvenanceStore(dir);
    await store.stamp("s", HUMAN_ROOT);
    await store.stamp("s", { origin: "spawned", depth: 3 });
    expect(await store.get("s")).toEqual({ origin: "spawned", depth: 3 });
  });

  it("stampIfAbsent records only when the chat has no marker yet (never clobbers)", async () => {
    const store = new RunProvenanceStore(dir);
    // Absent → records.
    await store.stampIfAbsent("s", SCHEDULED_ROOT);
    expect(await store.get("s")).toEqual({ origin: "scheduled", depth: 0 });
    // Already present → a wake must not relabel a human/spawned chat as scheduled.
    await store.stampIfAbsent("s", { origin: "human", depth: 0 });
    expect(await store.get("s")).toEqual({ origin: "scheduled", depth: 0 });
  });

  it("keeps distinct chats independent", async () => {
    const store = new RunProvenanceStore(dir);
    await store.stamp("human", HUMAN_ROOT);
    await store.stamp("spawn", childOf(HUMAN_ROOT));
    await store.stamp("sched", SCHEDULED_ROOT);
    expect(await store.get("human")).toEqual({ origin: "human", depth: 0 });
    expect(await store.get("spawn")).toEqual({ origin: "spawned", depth: 1 });
    expect(await store.get("sched")).toEqual({ origin: "scheduled", depth: 0 });
    expect(await store.get("unknown")).toBeUndefined();
  });

  it("survives a reload (a fresh store reads the persisted map)", async () => {
    await new RunProvenanceStore(dir).stamp("s1", childOf(HUMAN_ROOT));
    const reopened = new RunProvenanceStore(dir);
    expect(await reopened.get("s1")).toEqual({ origin: "spawned", depth: 1 });
    expect(await reopened.get("s2")).toBeUndefined();
  });

  it("ignores a blank/unsafe session id and a malformed marker", async () => {
    const store = new RunProvenanceStore(dir);
    await store.stamp("", HUMAN_ROOT); // unsafe id
    await store.stamp("has space", HUMAN_ROOT); // unsafe id
    // Malformed markers (bad origin / negative / non-numeric depth) are dropped.
    await store.stamp("bad1", { origin: "robot", depth: 0 } as unknown as RunProvenance);
    await store.stamp("bad2", { origin: "human", depth: -1 } as unknown as RunProvenance);
    await store.stamp("bad3", { origin: "human", depth: Number.NaN } as unknown as RunProvenance);
    expect(await store.get("")).toBeUndefined();
    expect(await store.get("has space")).toBeUndefined();
    expect(await store.get("bad1")).toBeUndefined();
    expect(await store.get("bad2")).toBeUndefined();
    expect(await store.get("bad3")).toBeUndefined();
    // Nothing valid was stamped, so no file was written.
    await expect(fs.access(stateFile())).rejects.toBeTruthy();
  });

  it("normalizes a fractional depth to a floored integer", async () => {
    const store = new RunProvenanceStore(dir);
    await store.stamp("s", { origin: "spawned", depth: 2.9 });
    expect(await store.get("s")).toEqual({ origin: "spawned", depth: 2 });
  });

  it("tolerates a corrupt / non-object / malformed-entry state file", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    expect(await new RunProvenanceStore(dir).get("s")).toBeUndefined();
    await fs.writeFile(stateFile(), "[1,2,3]", "utf8");
    expect(await new RunProvenanceStore(dir).get("s")).toBeUndefined();
    // A well-formed object whose entries are malformed drops just those entries.
    await fs.writeFile(
      stateFile(),
      JSON.stringify({ good: { origin: "human", depth: 0 }, bad: { origin: "x", depth: 1 } }),
      "utf8",
    );
    const store = new RunProvenanceStore(dir);
    expect(await store.get("good")).toEqual({ origin: "human", depth: 0 });
    expect(await store.get("bad")).toBeUndefined();
  });
});
