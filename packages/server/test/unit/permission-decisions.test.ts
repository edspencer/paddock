/**
 * The permission-decision sidecar (#971): each settled prompt is recorded against
 * its tool_use, survives a restart, and is joined onto the matching tool call
 * when the chat's history is read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PermissionDecisionStore,
  applyPermissionDecisions,
  decisionSubject,
  permissionDecisionFor,
  DECISION_SUBJECT_MAX,
  type PermissionDecision,
} from "../../src/permission-decisions.js";
import type { PendingPermissionWire } from "../../src/permission-prompts.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const WIRE: PendingPermissionWire = {
  id: "r1",
  projectSlug: "proj",
  sessionId: "s1",
  toolName: "Write",
  input: { file_path: "/home/u/.claude/notes.md", content: "x" },
  toolUseId: "toolu_1",
  requestedAt: 1000,
};

const decision = (over: Partial<PermissionDecision> = {}): PermissionDecision => ({
  toolUseId: "toolu_1",
  toolName: "Write",
  subject: "/home/u/.claude/notes.md",
  outcome: "once",
  requestedAt: 1000,
  decidedAt: 2000,
  ...over,
});

describe("permissionDecisionFor", () => {
  it("records the answer, the tool and what it was for", () => {
    expect(permissionDecisionFor(WIRE, { kind: "answered", answer: "always" }, 2000)).toEqual(
      decision({ outcome: "always" }),
    );
  });

  it("records a cancellation with its reason", () => {
    expect(
      permissionDecisionFor(WIRE, { kind: "cancelled", reason: "the turn ended" }, 2000),
    ).toEqual(decision({ outcome: "cancelled", reason: "the turn ended" }));
  });

  it("records nothing for a request that names no tool_use", () => {
    const { toolUseId: _, ...noId } = WIRE;
    expect(permissionDecisionFor(noId, { kind: "answered", answer: "deny" }, 2000)).toBeNull();
  });
});

describe("decisionSubject", () => {
  it("prefers the path or command, else the input as JSON, capped", () => {
    expect(decisionSubject({ command: "rm -rf build", description: "clean" })).toBe("rm -rf build");
    expect(decisionSubject({ a: 1 })).toBe('{"a":1}');
    const long = decisionSubject({ command: "x".repeat(DECISION_SUBJECT_MAX * 2) });
    expect(long).toHaveLength(DECISION_SUBJECT_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("PermissionDecisionStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir("paddock-permission-decisions-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("keeps a chat's decisions keyed by tool_use across a restart", async () => {
    const store = new PermissionDecisionStore(dir);
    expect((await store.list("s1")).size).toBe(0);
    await store.record("s1", decision());
    await store.record("s1", decision({ toolUseId: "toolu_2", outcome: "deny" }));
    await store.record("s2", decision({ outcome: "cancelled", reason: "aborted" }));

    const reloaded = new PermissionDecisionStore(dir);
    const s1 = await reloaded.list("s1");
    expect([...s1.keys()]).toEqual(["toolu_1", "toolu_2"]);
    expect(s1.get("toolu_2")?.outcome).toBe("deny");
    expect((await reloaded.list("s2")).get("toolu_1")?.reason).toBe("aborted");
  });

  it("ignores an unsafe session id and reads a corrupt file as empty", async () => {
    await fs.writeFile(path.join(dir, "permission-decisions.json"), "{not json", "utf8");
    const store = new PermissionDecisionStore(dir);
    expect((await store.list("s1")).size).toBe(0);
    await store.record("../x", decision());
    expect((await store.list("../x")).size).toBe(0);
  });

  it("drops malformed records from a hand-edited file", async () => {
    await fs.writeFile(
      path.join(dir, "permission-decisions.json"),
      JSON.stringify({ s1: { toolu_1: decision(), toolu_2: { ...decision(), outcome: "maybe" } } }),
      "utf8",
    );
    expect([...(await new PermissionDecisionStore(dir).list("s1")).keys()]).toEqual(["toolu_1"]);
  });
});

describe("applyPermissionDecisions", () => {
  it("attaches a decision to the tool call with the same tool_use id", () => {
    const messages = [
      { role: "assistant", content: "hi" },
      { role: "tool", content: "", toolCall: { toolName: "Write", toolUseId: "toolu_1" } },
      { role: "tool", content: "", toolCall: { toolName: "Read", toolUseId: "toolu_9" } },
    ];
    const out = applyPermissionDecisions(messages, new Map([["toolu_1", decision()]]));
    expect(out[0]).toBe(messages[0]);
    expect(out[1].toolCall?.permission).toEqual(decision());
    expect(out[2]).toBe(messages[2]);
  });
});
