import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MessageProvenanceStore,
  applyMessageProvenance,
  type MessageSender,
} from "../../src/message-provenance.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the per-MESSAGE provenance marker (issue #290): the sidecar
 * store's record/list round-trip + reload persistence + corruption tolerance,
 * and the content-ordered {@link applyMessageProvenance} join that attributes a
 * machine-injected user turn to its sender while leaving human-typed turns
 * unlabelled.
 */
const CHAT_SENDER: MessageSender = {
  kind: "chat",
  project: "paddock",
  sessionId: "sess-b",
  name: "Report-back test",
};
const SCHEDULE_SENDER: MessageSender = { kind: "schedule", name: "daily-manager", project: "paddock" };

describe("message provenance — store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("records + lists markers in order, round-tripping through a reload", async () => {
    const store = new MessageProvenanceStore(dir);
    await store.record("sess-a", CHAT_SENDER, "please report back");
    await store.record("sess-a", SCHEDULE_SENDER, "the scheduled kickoff");

    const list = await store.list("sess-a");
    expect(list).toHaveLength(2);
    expect(list[0].sender).toEqual(CHAT_SENDER);
    expect(list[0].content).toBe("please report back");
    expect(list[1].sender).toEqual(SCHEDULE_SENDER);

    // A fresh store over the same dir reloads the persisted markers.
    const reloaded = new MessageProvenanceStore(dir);
    const after = await reloaded.list("sess-a");
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.content)).toEqual(["please report back", "the scheduled kickoff"]);
  });

  it("trims stored content and marks/truncates an oversized prompt", async () => {
    const store = new MessageProvenanceStore(dir);
    await store.record("s", CHAT_SENDER, "   padded kickoff   ");
    const big = "x".repeat(20_000);
    await store.record("s", CHAT_SENDER, big);
    const list = await store.list("s");
    expect(list[0].content).toBe("padded kickoff");
    expect(list[0].truncated).toBeUndefined();
    expect(list[1].truncated).toBe(true);
    expect(list[1].content.length).toBeLessThan(big.length);
  });

  it("ignores an unsafe session id and an empty list for unknown sessions", async () => {
    const store = new MessageProvenanceStore(dir);
    await store.record("../escape", CHAT_SENDER, "nope");
    expect(await store.list("../escape")).toEqual([]);
    expect(await store.list("never-seen")).toEqual([]);
  });

  it("tolerates a corrupt state file (starts empty, then records)", async () => {
    await fs.writeFile(path.join(dir, "message-provenance.json"), "{ not json", "utf8");
    const store = new MessageProvenanceStore(dir);
    expect(await store.list("s")).toEqual([]);
    await store.record("s", CHAT_SENDER, "recovered");
    expect((await store.list("s"))[0].content).toBe("recovered");
  });

  it("concurrent records before first load don't drop markers (cached load promise)", async () => {
    const store = new MessageProvenanceStore(dir);
    await Promise.all([
      store.record("s", CHAT_SENDER, "one"),
      store.record("s", CHAT_SENDER, "two"),
      store.record("s", CHAT_SENDER, "three"),
    ]);
    const list = await store.list("s");
    expect(list).toHaveLength(3);
    expect(list.map((m) => m.content).sort()).toEqual(["one", "three", "two"]);
  });
});

describe("message provenance — applyMessageProvenance join", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (content: string) => ({ role: "assistant" as const, content });

  it("returns messages untouched when there are no markers", () => {
    const msgs = [user("hi"), assistant("hello")];
    expect(applyMessageProvenance(msgs, [])).toBe(msgs);
  });

  it("attributes a matching injected user turn, leaving human turns unlabelled", () => {
    const msgs = [
      user("i typed this myself"),
      user("please report back"),
      assistant("on it"),
    ];
    const out = applyMessageProvenance(msgs, [{ sender: CHAT_SENDER, content: "please report back" }]);
    expect(out[0].sender).toBeUndefined();
    expect(out[1].sender).toEqual(CHAT_SENDER);
    expect(out[2].sender).toBeUndefined();
  });

  it("consumes markers in order across interleaved human + injected turns", () => {
    const msgs = [
      user("first injected"),
      user("a human aside"),
      user("second injected"),
    ];
    const out = applyMessageProvenance(msgs, [
      { sender: CHAT_SENDER, content: "first injected" },
      { sender: SCHEDULE_SENDER, content: "second injected" },
    ]);
    expect(out[0].sender).toEqual(CHAT_SENDER);
    expect(out[1].sender).toBeUndefined();
    expect(out[2].sender).toEqual(SCHEDULE_SENDER);
  });

  it("matches a truncated marker by content prefix", () => {
    const long = "y".repeat(9000);
    const out = applyMessageProvenance([user(long)], [
      { sender: CHAT_SENDER, content: long.slice(0, 8192), truncated: true },
    ]);
    expect(out[0].sender).toEqual(CHAT_SENDER);
  });

  it("never attributes a tool message or a task-notification user line", () => {
    const msgs = [
      { role: "user" as const, content: "please report back", toolCall: { toolName: "X", output: "", isError: false } },
      { role: "user" as const, content: "<task-notification>\n<status>completed</status></task-notification>" },
      user("please report back"),
    ];
    const out = applyMessageProvenance(msgs, [{ sender: CHAT_SENDER, content: "please report back" }]);
    // The tool message + the notification are skipped; the plain user turn claims it.
    expect(out[0].sender).toBeUndefined();
    expect(out[1].sender).toBeUndefined();
    expect(out[2].sender).toEqual(CHAT_SENDER);
  });
});
