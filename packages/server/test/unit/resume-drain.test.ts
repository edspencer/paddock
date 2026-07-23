import { describe, it, expect } from "vitest";
import type { RuntimeSession, SDKMessage } from "@herdctl/core";
import { consumeResumedTurn } from "../../src/resume-drain.js";

/**
 * Unit coverage for the resume self-interrupt fix (`consumeResumedTurn`).
 *
 * The bug it fixes: on a resume, a stale async-input backlog replays as its own
 * turn ahead of the real turn; breaking the consume loop on that backlog turn's
 * `result` closes the CLI and kills the real (possibly slow) turn. The helper
 * breaks on a `result` only once the async queue has drained — so the real turn
 * is the last one it breaks on.
 *
 * We drive it with a fake session (a pushable message stream) and a scripted
 * `residueProbe` (standing in for the on-disk async-queue depth), so both the
 * no-backlog fast path and the backlog-drain path are exercised deterministically
 * without a real `claude` binary.
 */

// A fake RuntimeSession whose `messages` stream is driven by `push`.
function makeFakeSession(): { session: RuntimeSession; push: (m: SDKMessage) => void } {
  const queue: SDKMessage[] = [];
  let resolveNext: ((v: IteratorResult<SDKMessage>) => void) | null = null;
  const push = (m: SDKMessage): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: m, done: false });
    } else {
      queue.push(m);
    }
  };
  const messages: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          if (queue.length) return Promise.resolve({ value: queue.shift() as SDKMessage, done: false });
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
  const session = {
    messages,
    send: async () => {},
    interrupt: async () => {},
    listCommands: async () => [],
    setModel: async () => {},
    close: async () => {},
  } as unknown as RuntimeSession;
  return { session, push };
}

const RESULT = (): SDKMessage => ({ type: "result", subtype: "success", success: true } as unknown as SDKMessage);
const TEXT = (t: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text: t }] } } as unknown as SDKMessage);
const BACKLOG_NOTE = (): SDKMessage =>
  ({ type: "user", message: { content: "<task-notification><status>killed</status></task-notification>" } } as unknown as SDKMessage);

// A residueProbe returning a scripted sequence (last value sticks).
function scriptedResidue(seq: number[]): () => Promise<number> {
  let i = 0;
  return () => Promise.resolve(seq[Math.min(i++, seq.length - 1)]);
}

function collectText(surfaced: string[]) {
  return (m: SDKMessage): void => {
    const content = (m as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content) && (content[0] as { text?: string })?.text) {
      surfaced.push((content[0] as { text: string }).text);
    } else if (typeof content === "string") {
      surfaced.push(content);
    }
  };
}

describe("consumeResumedTurn", () => {
  it("no backlog (residue 0): breaks after the first result — no drain, nothing extra consumed", async () => {
    const { session, push } = makeFakeSession();
    push(TEXT("hi"));
    push(RESULT());
    push(TEXT("SHOULD-NOT-APPEAR"));
    push(RESULT());

    const surfaced: string[] = [];
    const res = await consumeResumedTurn(session, {
      residueProbe: scriptedResidue([0]),
      onMessage: collectText(surfaced),
    });

    expect(res.success).toBe(true);
    expect(surfaced).toEqual(["hi"]);
  });

  it("backlog present: consumes the backlog turn AND the real turn, breaking only once the queue drains", async () => {
    const { session, push } = makeFakeSession();
    // Backlog turn, then the real turn.
    push(BACKLOG_NOTE());
    push(RESULT());
    push(TEXT("the real answer"));
    push(RESULT());

    const surfaced: string[] = [];
    let logged = "";
    const res = await consumeResumedTurn(session, {
      // depth: 2 (backlog+real) → 1 (real) after backlog turn → 0 after real turn.
      residueProbe: scriptedResidue([2, 1, 1, 0]),
      onMessage: collectText(surfaced),
      log: (m) => {
        logged = m;
      },
    });

    expect(res.success).toBe(true);
    // Did NOT break after the backlog turn; broke after the real turn (queue empty).
    expect(surfaced).toContain("the real answer");
    expect(surfaced.filter((s) => s.includes("task-notification")).length).toBe(1);
    // Logged that exactly one backlog turn was drained.
    expect(logged).toMatch(/drained 1 backlog turn/);
  });

  it("propagates an error result as success:false", async () => {
    const { session, push } = makeFakeSession();
    push({ type: "result", subtype: "error_max_turns", success: false } as unknown as SDKMessage);
    const res = await consumeResumedTurn(session, { residueProbe: scriptedResidue([0]) });
    expect(res.success).toBe(false);
  });
});
