/**
 * The background-phase turn is cancellable (#528).
 *
 * After a session-mode turn's primary `result`, the session can stay open —
 * the reaper keeps it alive while the turn's background work runs — and
 * autonomous re-invocation turns keep arriving on the same stream. Paddock
 * renders that stretch through `makeBackgroundTurnSink` as ONE hub turn, shown
 * to the user as running, with a Stop button.
 *
 * That Stop used to be structurally incapable of firing. The sink opened its
 * turn with `hub.startTurn(...)` and never called `setJobId`, so every frame and
 * every `chat:active` carried `jobId: null`. The client's deferred-cancel waits
 * for a jobId that never arrives, so clicking Stop put NOTHING on the wire — no
 * request, no error, no log line. `setJobId` was being called at only two of the
 * five turn-start sites, and this was one of the three that missed.
 *
 * So these assert the identity itself: the sink publishes a jobId, and registers
 * it against the session it belongs to so `HerdctlService.cancel` can route it
 * to a reap (covered in herdctl-cancel-routing.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@herdctl/core";
import { makeTurnEngine } from "../../src/ws-turn.js";
import { SessionHub } from "../../src/session-hub.js";
import type { ChatHandlerDeps } from "../../src/ws-context.js";

type Active = { sessionId: string; projectSlug: string; jobId: string | null; running: boolean };

function harness() {
  const registered: Array<[string, string]> = [];
  const unregistered: string[] = [];
  const active: Active[] = [];

  // makeTurnEngine wires a lot of unrelated machinery at construction (triggers,
  // wake injection, recovery). Only the background-sink surface matters here, so
  // auto-stub everything else rather than hand-listing collaborators this test
  // has no opinion about — otherwise it breaks every time an unrelated hook is
  // added to the engine.
  const explicit: Record<string, unknown> = {
    registerBackgroundTurn: vi.fn((jobId: string, sessionId: string) => {
      registered.push([jobId, sessionId]);
    }),
    unregisterBackgroundTurn: vi.fn((jobId: string) => {
      unregistered.push(jobId);
    }),
  };
  const herdctl = new Proxy(explicit, {
    get: (target, prop: string) => (target[prop] ??= vi.fn()),
  });

  const hub = new SessionHub();
  hub.onActive = (a: Active) => active.push(a);
  const deps = {
    herdctl,
    cfg: { recovery: {} },
    projects: { get: vi.fn(async () => null) },
    attachments: { save: vi.fn(async () => "") },
  } as unknown as ChatHandlerDeps;

  const engine = makeTurnEngine({ deps, hub });
  return { engine, registered, unregistered, active, herdctl };
}

/** A main-lane (non-sidechain) assistant message on a background stream. */
const assistantMsg = (sessionId: string, text = "background work finished"): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    message: { model: "claude-opus-5", content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

describe("background-phase turn is cancellable (#528)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("publishes a jobId on the turn it opens", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc"));

    // chat:active is what arms Stop in the client before any content frame.
    const running = h.active.filter((a) => a.running);
    expect(running.length).toBeGreaterThan(0);
    // The regression: this was null for the entire background stretch.
    expect(running.at(-1)!.jobId).toEqual(expect.any(String));
    expect(running.at(-1)!.sessionId).toBe("sess-abc");
  });

  it("registers that jobId against the session, so cancel can reap it", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc"));

    expect(h.registered).toHaveLength(1);
    const [jobId, sessionId] = h.registered[0]!;
    expect(sessionId).toBe("sess-abc");
    // The id the client is told to cancel is the id the server can act on —
    // if these two ever diverge, Stop silently does nothing again.
    expect(h.active.filter((a) => a.running).at(-1)!.jobId).toBe(jobId);
  });

  it("registers once across a multi-message stretch, not once per message", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc", "one"));
    await sink.onMessage(assistantMsg("sess-abc", "two"));
    await sink.onMessage(assistantMsg("sess-abc", "three"));

    expect(h.registered).toHaveLength(1);
  });

  it("unregisters when the stream ends, so a late Stop cannot reap a reused id", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc"));
    const [jobId] = h.registered[0]!;

    sink.onDone();
    expect(h.unregistered).toEqual([jobId]);
  });

  it("unregisters exactly once even if onDone runs twice", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc"));

    sink.onDone();
    sink.onDone();
    expect(h.unregistered).toHaveLength(1);
  });

  it("opens no turn — and registers nothing — for a sidechain-only stretch", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage({
      type: "assistant",
      session_id: "sess-abc",
      parent_tool_use_id: "toolu_task_1",
      message: { content: [{ type: "text", text: "nested sub-agent step" }] },
    } as unknown as SDKMessage);

    expect(h.registered).toHaveLength(0);
    expect(h.active.filter((a) => a.running)).toHaveLength(0);
    sink.onDone(); // must not throw, and must not unregister a nonexistent id
    expect(h.unregistered).toHaveLength(0);
  });

  it("still emits the terminal chat:complete that unlocks the UI", async () => {
    const sink = h.engine.makeBackgroundTurnSink("demo");
    await sink.onMessage(assistantMsg("sess-abc"));

    sink.onDone();
    // running:false is what clears `streaming` client-side (and with it the
    // "thinking" indicator and the locked composer).
    expect(h.active.at(-1)!.running).toBe(false);
  });
});
