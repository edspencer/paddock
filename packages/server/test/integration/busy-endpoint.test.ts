/**
 * `GET /api/busy` against a real app and a real turn (CLI contract SPEC §4, §8).
 *
 * ## What only this layer can prove
 *
 * `busy.ts` is pure and unit-tested with injected sources, so the arithmetic
 * and the predicate are covered on their own. What a unit test cannot see is
 * the WIRING: whether the route reads the hub that the turn engine actually
 * registers turns on, or a different one. Three of these — a hub that is
 * `undefined` on a server built without the WS layer, a registry hoisted into
 * `ChatHandlerContext` for the first time in wave C1, and a herdctl scheduler
 * reached through two optional accessors — are exactly the mistakes that type-
 * check and then report an idle instance forever.
 *
 * So the load-bearing test here is: start a turn that will not finish, and ask
 * the endpoint. That is the question `paddock service stop` asks, through the
 * same route, with nothing stubbed.
 *
 * ## The one thing it cannot prove
 *
 * `counts.background` is zero in this harness and should be. These tests run on
 * `driveMode: batch` (the fake `claude` is a one-shot CLI), so there is no
 * session-lifecycle reaper and `herdctl.isSdkSessionLive` is false for every
 * session — which is the filter `/api/busy` applies. The unhappy path that
 * MATTERS about that is tested here instead, and it is the one that bites: a
 * batch turn's background tasks stay in the registry after the turn ends, and
 * must not report the instance busy for the rest of its life.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs } from "../helpers/ws.js";
import { PADDOCK_VERSION } from "../../src/version.js";

interface BusyBody {
  busy: boolean;
  version: string;
  counts: { chat: number; background: number; job: number };
}

describe("integration: GET /api/busy (CLI contract SPEC §4)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "[[HANG]] hold": "Working on it.",
        "[[BGTASK]] go": "Kicked off some background work.",
        hello: "Hi.",
      },
      // The post-turn sweeper fires its own `claude`, and a sweep in flight is
      // deliberately NOT busy (see busy.ts) — but a sweep racing a count is
      // still noise in an assertion, so it is parked for these tests.
      sweepIntervalMs: 600_000,
      env: { PADDOCK_FAKE_BGTASK_MS: "1500" },
    });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function busy(): Promise<BusyBody> {
    const res = await t.app.inject({ method: "GET", url: "/api/busy" });
    expect(res.statusCode).toBe(200);
    return res.json() as BusyBody;
  }

  async function freshProject(): Promise<string> {
    const name = `Busy ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  it("answers the shape the contract fixes, with this instance's version", async () => {
    const body = await busy();
    expect(body).toEqual({
      busy: false,
      version: PADDOCK_VERSION,
      counts: { chat: 0, background: 0, job: 0 },
    });
    // §4: counts only. No label, id or title, for any caller, until §10's first
    // question is settled. Asserted on the live route as well as on the pure
    // function, because this is the shape an unauthenticated caller receives.
    expect(JSON.stringify(body)).not.toMatch(/sessionId|projectSlug|title|slug/i);
  });

  /**
   * THE test. `[[HANG]]` streams its reply and then blocks without writing a
   * terminal result, so the turn is genuinely in flight — the state a restart
   * would cut short, and the state the busy check exists to refuse on.
   */
  it("reports a running chat turn as busy, and goes quiet when it ends", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      expect((await busy()).busy).toBe(false);

      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "[[HANG]] hold" },
      });
      // Wait for the turn to be REGISTERED on the hub rather than for the text:
      // `chat:active` with `running: true` is the hub's own announcement, so
      // this cannot pass before the thing being counted exists.
      await ws.waitFor(
        (e) => e.type === "chat:active" && e.payload?.running === true,
        { timeoutMs: 20_000 },
      );

      const during = await busy();
      expect(during.busy).toBe(true);
      expect(during.counts.chat).toBeGreaterThanOrEqual(1);
      expect(during.version).toBe(PADDOCK_VERSION);

      // Stop it — the same thing the UI's Stop button does — and the instance
      // must report itself free again. A count that only ever goes up is the
      // failure that would make every later `service stop` refuse.
      const active = ws.events.find(
        (e) => e.type === "chat:active" && e.payload?.running === true,
      );
      const jobId = active?.payload?.jobId as string | undefined;
      expect(jobId).toBeTruthy();
      ws.send({ type: "chat:cancel", payload: { jobId } });
      await ws.waitFor(
        (e) =>
          (e.type === "chat:active" && e.payload?.running === false) ||
          e.type === "chat:complete" ||
          e.type === "chat:error",
        { timeoutMs: 20_000 },
      );

      await expectEventually(async () => {
        const after = await busy();
        expect(after.counts.chat).toBe(0);
        expect(after.busy).toBe(false);
      });
    } finally {
      ws.close();
    }
  });

  /**
   * The unhappy path for the background count, and the reason it is filtered on
   * SDK liveness rather than read straight off the registry.
   *
   * Nothing resets `BackgroundRegistry` when a one-shot `claude` exits — the
   * SDK's level signal is per-process and emits nothing at startup — so on
   * `driveMode: batch` a finished turn's tasks sit in the registry
   * indefinitely. Counting them would report this instance busy for the rest of
   * its life, and every `paddock service stop` after that one turn would refuse
   * with 75 and never recover.
   *
   * So: drive a turn that registers background tasks, let it END, confirm the
   * registry still lists them, and confirm `/api/busy` says not busy.
   */
  it("does not count background tasks left behind by a finished batch turn", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" },
      });
      // The registry has the tasks: this is the server's own broadcast of them.
      const frame = await ws.waitFor(
        (e) =>
          e.type === "chat:background" &&
          e.payload?.projectSlug === slug &&
          ((e.payload?.tasks as unknown[]) ?? []).length > 0,
        { timeoutMs: 20_000 },
      );
      const sessionId = frame.payload!.sessionId as string;
      expect(t.hub).toBeDefined();

      await ws.waitFor((e) => e.type === "chat:complete" || e.type === "chat:error", {
        timeoutMs: 20_000,
      });

      // The turn is over, and its tasks are STILL in the registry — stated as
      // an assertion so this test fails loudly if that leak is ever fixed,
      // rather than silently becoming a test of nothing.
      const registry = t.background;
      expect(registry.list(sessionId).length).toBeGreaterThan(0);
      expect(registry.liveTaskCount()).toBeGreaterThan(0);

      // And the endpoint does not report them, because the session is not live.
      await expectEventually(async () => {
        const body = await busy();
        expect(body.counts.background).toBe(0);
        expect(body.counts.chat).toBe(0);
        expect(body.busy).toBe(false);
      });
    } finally {
      ws.close();
    }
  });

  // §4: "it must be cheap… reads in-memory state, never walks the disk, and
  // answers in well under a second". A loose bound, because a loaded CI runner
  // is not a stopwatch — but 50 calls that each re-read the fleet state file
  // (the shape the ROADMAP's `fleetStatus()` would have had) do not fit in it.
  it("answers 50 times well inside a second", async () => {
    const started = Date.now();
    for (let i = 0; i < 50; i++) await busy();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** Poll an assertion until it holds, for state that settles a tick after a frame. */
async function expectEventually(
  assertion: () => Promise<void>,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
