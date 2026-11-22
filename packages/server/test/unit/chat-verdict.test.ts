import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ChatVerdictStore,
  currentVerdict,
  makeVerdictResolver,
  type ChatVerdict,
} from "../../src/chat-verdict.js";
import { buildProjectChats } from "../../src/chat-dto.js";
import type { SessionWithActivity } from "../../src/last-activity.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * The post-turn verdict sidecar (`chat-verdict.json`) and the rule that decides
 * whether a chat list shows a stored verdict.
 */
const verdict = (over: Partial<ChatVerdict> = {}): ChatVerdict => ({
  verdict: "could-continue",
  reason: "Offered to add tests next.",
  turnCompletedAt: "2026-11-05T10:00:00.000Z",
  judgedAt: "2026-11-05T10:00:04.000Z",
  model: "claude-haiku-4-5-20251001",
  ...over,
});

describe("ChatVerdictStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "chat-verdict.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-verdict-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("reads as none, and writes no file, until a verdict is stored", async () => {
    const store = new ChatVerdictStore(dir);
    expect(await store.get("keeper-a", "s1")).toBeUndefined();
    await expect(fs.access(stateFile())).rejects.toBeTruthy();
  });

  it("stores, replaces and persists a verdict across instances", async () => {
    const store = new ChatVerdictStore(dir);
    await store.set("keeper-a", "s1", verdict());
    await store.set("keeper-a", "s1", verdict({ verdict: "finished", reason: "Done." }));
    expect((await store.get("keeper-a", "s1"))?.verdict).toBe("finished");

    const reloaded = new ChatVerdictStore(dir);
    expect(await reloaded.get("keeper-a", "s1")).toEqual(
      verdict({ verdict: "finished", reason: "Done." }),
    );
  });

  it("keys by agent AND session, so neither collides", async () => {
    const store = new ChatVerdictStore(dir);
    await store.set("keeper-a", "s1", verdict());
    expect(await store.get("keeper-b", "s1")).toBeUndefined();
    expect(await store.get("keeper-a", "s2")).toBeUndefined();
  });

  it("forgets a chat's verdict, and reports whether there was one", async () => {
    const store = new ChatVerdictStore(dir);
    await store.set("keeper-a", "s1", verdict());
    expect(await store.forget("keeper-a", "s1")).toBe(true);
    expect(await store.forget("keeper-a", "s1")).toBe(false);
    expect(await new ChatVerdictStore(dir).get("keeper-a", "s1")).toBeUndefined();
  });

  it("tolerates a corrupt file, and drops malformed entries from a hand-edited one", async () => {
    await fs.writeFile(stateFile(), "{not json", "utf8");
    expect(await new ChatVerdictStore(dir).get("keeper-a", "s1")).toBeUndefined();

    await fs.writeFile(
      stateFile(),
      JSON.stringify({
        "keeper-a\u0000good": verdict(),
        "keeper-a\u0000bad-kind": { ...verdict(), verdict: "maybe" },
        "keeper-a\u0000no-reason": { ...verdict(), reason: 3 },
      }),
      "utf8",
    );
    const store = new ChatVerdictStore(dir);
    expect(await store.get("keeper-a", "good")).toEqual(verdict());
    expect(await store.get("keeper-a", "bad-kind")).toBeUndefined();
    expect(await store.get("keeper-a", "no-reason")).toBeUndefined();
  });
});

describe("currentVerdict", () => {
  it("shows a verdict that judged the chat's current last message, without the model", () => {
    expect(currentVerdict(verdict(), "2026-11-05T10:00:00.000Z")).toEqual({
      verdict: "could-continue",
      reason: "Offered to add tests next.",
      turnCompletedAt: "2026-11-05T10:00:00.000Z",
      judgedAt: "2026-11-05T10:00:04.000Z",
    });
  });

  it("withholds a verdict a later message has outdated", () => {
    expect(currentVerdict(verdict(), "2026-11-05T10:05:00.000Z")).toBeUndefined();
  });

  it("shows a verdict as stored when the chat has no datable last message", () => {
    expect(currentVerdict(verdict(), undefined)?.verdict).toBe("could-continue");
  });

  it("is undefined with nothing stored", () => {
    expect(currentVerdict(undefined, "2026-11-05T10:00:00.000Z")).toBeUndefined();
  });
});

describe("verdict on the chat DTO (buildProjectChats)", () => {
  const session = (sessionId: string, lastMessageAt?: string): SessionWithActivity => ({
    sessionId,
    workingDirectory: "/tmp/demo",
    mtime: "2026-11-05T10:00:00.000Z",
    resumable: true,
    preview: "hello",
    ...(lastMessageAt ? { lastMessageAt } : {}),
  }) as SessionWithActivity;

  it("carries the keeper's current verdict and omits a stale or missing one", async () => {
    const stored = new Map<string, ChatVerdict>([
      ["current", verdict()],
      ["stale", verdict()],
    ]);
    const store = {
      get: async (agent: string, sessionId: string) =>
        agent === "keeper-demo" ? stored.get(sessionId) : undefined,
    };
    const chats = (await buildProjectChats(
      "/tmp/demo",
      [
        session("current", "2026-11-05T10:00:00.000Z"),
        session("stale", "2026-11-05T11:00:00.000Z"),
        session("none", "2026-11-05T10:00:00.000Z"),
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeVerdictResolver(store, "keeper-demo"),
    )) as Array<{ sessionId: string; verdict?: { verdict: string } }>;
    const byId = new Map(chats.map((c) => [c.sessionId, c]));
    expect(byId.get("current")?.verdict?.verdict).toBe("could-continue");
    expect(byId.get("stale")).not.toHaveProperty("verdict");
    expect(byId.get("none")).not.toHaveProperty("verdict");
  });

  it("resolves to no resolver when no store is wired", () => {
    expect(makeVerdictResolver(undefined, "keeper-demo")).toBeUndefined();
  });
});
