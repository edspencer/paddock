import { describe, it, expect } from "vitest";
import { mergeHydratedTurns, type Turn } from "./turnModel";

/**
 * `mergeHydratedTurns` (issue #726) — folding the live frames that arrived while a
 * transcript fetch was in flight into the snapshot that fetch returned.
 *
 * The E2E (`test/e2e/journey-remount-hydration.spec.ts`) proves the end-to-end
 * behaviour in a browser; this pins the merge rules themselves, including the
 * overlap cases that are awkward to stage against a real server.
 */

const user = (content: string): Turn => ({ kind: "user", id: `u:${content}`, content });
const assistant = (content: string, streaming = false): Turn => ({
  kind: "assistant",
  id: `a:${content}`,
  content,
  streaming,
});
const tool = (toolUseId: string, over: Record<string, unknown> = {}): Turn => ({
  kind: "tool",
  id: `t:${toolUseId}`,
  tool: {
    toolName: "Task",
    output: "",
    isError: false,
    toolUseId,
    ...over,
  },
});

describe("mergeHydratedTurns", () => {
  it("is the plain snapshot when no live frames arrived (the fast path)", () => {
    const snap = [user("hi"), assistant("hello")];
    // Localhost answers /messages in single-digit ms, so this is what almost
    // every hydration does — and it must stay a straight replace.
    expect(mergeHydratedTurns(snap, [])).toBe(snap);
  });

  it("is the live turns when the snapshot is empty", () => {
    const live = [assistant("streamed")];
    expect(mergeHydratedTurns([], live)).toBe(live);
  });

  it("appends a reply the snapshot was read too early to contain", () => {
    // The whole bug: the snapshot has the user's message, the reply streamed
    // after the server read it, and a wholesale replace threw the reply away.
    const merged = mergeHydratedTurns([user("q")], [assistant("the answer")]);
    expect(merged.map((t) => t.kind)).toEqual(["user", "assistant"]);
    expect(merged[1]).toMatchObject({ content: "the answer" });
  });

  it("does not duplicate a turn present in BOTH the snapshot and the live list", () => {
    const merged = mergeHydratedTurns(
      [user("q"), assistant("done")],
      [assistant("done"), user("next")],
    );
    expect(merged.map((t) => t.kind)).toEqual(["user", "assistant", "user"]);
  });

  it("keeps the LONGER assistant text — the live bubble accumulates chunk by chunk", () => {
    // The snapshot caught the message mid-write; the live bubble has more of it.
    const merged = mergeHydratedTurns([assistant("Ack")], [assistant("Acknowledged: hi", true)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: "Acknowledged: hi" });
  });

  it("keeps the snapshot's text when the live bubble is the shorter view", () => {
    const merged = mergeHydratedTurns([assistant("Acknowledged: hi")], [assistant("Ack", true)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: "Acknowledged: hi", streaming: false });
  });

  it("settles a snapshot's pending tool row from the live completion", () => {
    // The second half of #726: the snapshot was read while the tool was in
    // flight, so its row is pending; the reconciliation arrived live. Merging on
    // toolUseId settles it instead of leaving a card spinning forever.
    const merged = mergeHydratedTurns(
      [tool("toolu_1", { pending: true, editDiff: { added: 1 } })],
      [tool("toolu_1", { output: "slow task done", durationMs: 12_000 })],
    );
    expect(merged).toHaveLength(1);
    const t = merged[0];
    expect(t.kind).toBe("tool");
    if (t.kind !== "tool") return;
    expect(t.tool.pending).toBe(false);
    expect(t.tool.output).toBe("slow task done");
    // …while keeping the history-only enrichment the live frame never carries.
    expect(t.tool.editDiff).toEqual({ added: 1 });
  });

  it("appends a tool the snapshot has never seen", () => {
    const merged = mergeHydratedTurns([user("q")], [tool("toolu_new", { pending: true })]);
    expect(merged).toHaveLength(2);
  });

  it("dedupes non-text turns by content signature", () => {
    const cmd = (c: string): Turn => ({ kind: "command", id: `c:${c}`, command: c });
    const merged = mergeHydratedTurns([user("q"), cmd("/compact")], [cmd("/compact")]);
    expect(merged).toHaveLength(2);
  });

  it("preserves the snapshot's order and puts new live turns after it", () => {
    const merged = mergeHydratedTurns(
      [user("one"), assistant("two")],
      [user("three"), assistant("four")],
    );
    expect(merged.map((t) => (t.kind === "user" ? t.content : (t as { content: string }).content)))
      .toEqual(["one", "two", "three", "four"]);
  });
});
