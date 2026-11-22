/**
 * The pending permission-prompt store (#971): a parked request resolves once
 * with the user's answer, is cancelled when its turn goes away, and is visible
 * in the connect-time snapshot while it waits.
 */
import { describe, it, expect } from "vitest";
import { PermissionPromptStore, type PendingPermissionWire } from "../../src/permission-prompts.js";

const REQ = {
  projectSlug: "proj",
  sessionId: "s1",
  toolName: "Edit",
  input: { file_path: "/home/u/.claude/settings.json" },
  toolUseId: "toolu_1",
  alwaysAllowed: true,
};

function recordChanges(store: PermissionPromptStore) {
  const frames: Array<{ sessionId: string; requests: PendingPermissionWire[] }> = [];
  store.onChange = (_slug, sessionId, requests) => frames.push({ sessionId, requests });
  return frames;
}

describe("PermissionPromptStore", () => {
  it("resolves a parked request with the user's answer", async () => {
    const store = new PermissionPromptStore();
    const frames = recordChanges(store);
    const pending = store.open(REQ);
    const [req] = store.pendingFor("s1");
    expect(req).toMatchObject({ toolName: "Edit", sessionId: "s1", toolUseId: "toolu_1" });
    expect(frames.at(-1)!.requests).toHaveLength(1);

    expect(store.answer("s1", req.id, "always")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "answered", answer: "always" });
    expect(store.pendingFor("s1")).toEqual([]);
    // The level frame after the settle is empty: the card goes away everywhere.
    expect(frames.at(-1)).toEqual({ sessionId: "s1", requests: [] });
  });

  it("settles an always answer as once when the request does not offer always", async () => {
    const store = new PermissionPromptStore();
    const settled: string[] = [];
    store.onSettle = (_req, outcome) =>
      settled.push(outcome.kind === "answered" ? outcome.answer : outcome.kind);
    const pending = store.open({ ...REQ, alwaysAllowed: false });
    expect(store.answer("s1", store.pendingFor("s1")[0].id, "always")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "answered", answer: "once" });
    expect(settled).toEqual(["once"]);
  });

  it("ignores a second answer for the same request", async () => {
    const store = new PermissionPromptStore();
    const pending = store.open(REQ);
    const { id } = store.pendingFor("s1")[0];
    expect(store.answer("s1", id, "once")).toBe(true);
    expect(store.answer("s1", id, "deny")).toBe(false);
    await expect(pending).resolves.toEqual({ kind: "answered", answer: "once" });
  });

  it("cancels every request on a session, leaving other sessions alone", async () => {
    const store = new PermissionPromptStore();
    const a = store.open(REQ);
    const b = store.open({ ...REQ, toolName: "Bash", input: { command: "ls" } });
    const other = store.open({ ...REQ, sessionId: "s2" });

    expect(store.cancelSession("s1", "the turn was stopped")).toBe(2);
    await expect(a).resolves.toEqual({ kind: "cancelled", reason: "the turn was stopped" });
    await expect(b).resolves.toEqual({ kind: "cancelled", reason: "the turn was stopped" });
    expect(store.pendingFor("s2")).toHaveLength(1);
    expect(store.cancelSession("s1", "again")).toBe(0);

    store.answer("s2", store.pendingFor("s2")[0].id, "deny");
    await expect(other).resolves.toEqual({ kind: "answered", answer: "deny" });
  });

  it("cancels when the abort signal fires, and refuses an already-aborted one", async () => {
    const store = new PermissionPromptStore();
    const ac = new AbortController();
    const pending = store.open(REQ, ac.signal);
    ac.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "aborted" });
    expect(store.pendingFor("s1")).toEqual([]);

    const pre = new AbortController();
    pre.abort();
    await expect(store.open(REQ, pre.signal)).resolves.toMatchObject({ kind: "cancelled" });
    expect(store.pendingFor("s1")).toEqual([]);
  });

  it("reports each settle once, with its outcome, before the frame that drops it", async () => {
    const store = new PermissionPromptStore();
    const events: string[] = [];
    store.onChange = (_slug, _sid, requests) => events.push(`change:${requests.length}`);
    store.onSettle = (req, outcome) =>
      events.push(`settle:${req.toolUseId}:${JSON.stringify(outcome)}`);
    void store.open(REQ);
    void store.open({ ...REQ, toolUseId: "toolu_2" });
    const { id } = store.pendingFor("s1")[0];
    store.answer("s1", id, "once");
    store.answer("s1", id, "deny");
    store.cancelSession("s1", "the turn ended");
    expect(events).toEqual([
      "change:1",
      "change:2",
      'settle:toolu_1:{"kind":"answered","answer":"once"}',
      "change:1",
      'settle:toolu_2:{"kind":"cancelled","reason":"the turn ended"}',
      "change:0",
    ]);
  });

  it("snapshots every session with pending requests, for replay on connect", () => {
    const store = new PermissionPromptStore();
    void store.open(REQ);
    void store.open({ ...REQ, toolName: "Write" });
    void store.open({ ...REQ, projectSlug: "other", sessionId: "s2" });

    const snap = store.snapshot();
    expect(snap.map((s) => [s.projectSlug, s.sessionId, s.requests.length])).toEqual([
      ["proj", "s1", 2],
      ["other", "s2", 1],
    ]);
    // Oldest first, so a replayed card stack renders in the order it was asked.
    expect(snap[0].requests.map((r) => r.toolName)).toEqual(["Edit", "Write"]);

    store.cancelSession("s1", "x");
    expect(store.snapshot().map((s) => s.sessionId)).toEqual(["s2"]);
  });
});
