/**
 * WS live background-work signal (#604).
 *
 * The server tracks the SDK's task-lifecycle system messages and broadcasts the
 * live set as `chat:background`. Two things must be true end to end:
 *
 *  1. the frame carries the tasks, with the detail the edge signals add; and
 *  2. `chat:active` keeps reporting `running: true` while background work is in
 *     flight — the actual defect in #604, where a session with minutes of
 *     background work left was announced as idle the moment the turn returned.
 *
 * Driven by the fake claude's `[[BGTASK]]` directive, which writes the same
 * system lines the real SDK streams. herdctl's CLI runtime yields every parsed
 * transcript line unfiltered, so this exercises the production path.
 *
 * Each test uses its own project to avoid the cross-test sweep race (see
 * ws-reattach.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: WS background-work signal (#604)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "[[BGTASK]] go": "Kicked off some background work." },
      sweepIntervalMs: 600_000,
      env: { PADDOCK_FAKE_BGTASK_MS: "1500" },
    });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Bg ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  const bgFrame = (slug: string) => (e: WsEvent) =>
    e.type === "chat:background" && e.payload?.projectSlug === slug;

  it("broadcasts the live task set, then shrinks it as work finishes", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });

      // The first frame carries BOTH tasks, from the level signal.
      const first = await ws.waitFor(
        (e) => bgFrame(slug)(e) && (e.payload?.tasks as unknown[])?.length === 2,
        { timeoutMs: 20_000 },
      );
      const tasks = first.payload!.tasks as { type: string; role: string; description: string }[];
      // The RAW discriminants the CLI actually puts on the wire, carried through
      // verbatim, plus the role the registry derives from them (#846). Asserting
      // both is the point: the raw value is what production sends, the role is
      // what the UI is allowed to render.
      expect(tasks.map((x) => x.type).sort()).toEqual(["local_bash", "monitor_mcp"]);
      expect(tasks.map((x) => x.role).sort()).toEqual(["monitor", "shell"]);
      expect(tasks.find((x) => x.role === "monitor")!.description).toBe("errors in deploy.log");

      // Edge enrichment lands on the existing row rather than creating a new one.
      const enriched = await ws.waitFor(
        (e) =>
          bgFrame(slug)(e) &&
          ((e.payload?.tasks as { lastToolName?: string }[]) ?? []).some((x) =>
            x.lastToolName?.startsWith("poll #"),
          ),
        { timeoutMs: 20_000 },
      );
      expect((enriched.payload!.tasks as unknown[]).length).toBe(2);

      // The shell completes; REPLACE leaves only the monitor.
      const shrunk = await ws.waitFor(
        (e) => bgFrame(slug)(e) && (e.payload?.tasks as unknown[])?.length === 1,
        { timeoutMs: 20_000 },
      );
      expect((shrunk.payload!.tasks as { type: string; role: string }[])[0]).toMatchObject({
        type: "monitor_mcp",
        role: "monitor",
      });
    } finally {
      ws.close();
    }
  }, 40_000);

  /**
   * #853's join key, asserted on the LIVE wire.
   *
   * The bar recovers a background shell's COMMAND by matching the task's
   * `toolUseId` against the launching Bash tool call, whose `inputSummary` IS
   * the command (`getToolInputSummary`). `ToolCall.toolUseId` was documented in
   * the web client as history-only — if that were true, the join would go dark
   * for a shell launched in the current turn and the command would appear only
   * after a reload.
   *
   * So this pins both halves as they arrive DURING the turn, from the real
   * transcript the fake writes: the shell's `toolUseId`, and a `chat:tool_start`
   * carrying that same id with the command on it. A component test cannot make
   * this assertion — it supplies both sides of the join itself, so an id
   * mismatch between the two sources is invisible to it. This is the test that
   * would go red if either source stopped carrying the id.
   */
  it("carries the join key live: the shell's toolUseId names the Bash call with the command (#853)", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });

      const frame = await ws.waitFor(
        (e) =>
          bgFrame(slug)(e) &&
          ((e.payload?.tasks as { role?: string; toolUseId?: string }[]) ?? []).some(
            (x) => x.role === "shell" && x.toolUseId,
          ),
        { timeoutMs: 20_000 },
      );
      const shell = (frame.payload!.tasks as { role: string; toolUseId?: string }[]).find(
        (x) => x.role === "shell",
      )!;
      expect(shell.toolUseId).toMatch(/^toolu_/);

      // The other half, on a LIVE frame — not fetched from history.
      const launch = ws.events.find(
        (e) =>
          (e.type === "chat:tool_start" || e.type === "chat:tool_call") &&
          e.payload?.projectSlug === slug &&
          e.payload?.toolUseId === shell.toolUseId,
      );
      expect(launch, "no live tool frame carried the shell's toolUseId").toBeDefined();
      expect(launch!.payload!.toolName).toBe("Bash");
      // `inputSummary` for a Bash call is the command itself — what the bar shows.
      expect(String(launch!.payload!.inputSummary)).toContain("SCANDONE");
    } finally {
      ws.close();
    }
  }, 40_000);

  it("keeps chat:active running:true while background work is in flight (#604)", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });

      // Wait until background work is live...
      await ws.waitFor(
        (e) => bgFrame(slug)(e) && ((e.payload?.tasks as unknown[]) ?? []).length > 0,
        { timeoutMs: 20_000 },
      );
      // ...then wait for the turn's own completion. Before this fix, the
      // `chat:active` that follows carried running:false with minutes of work left.
      await ws.waitFor((e) => e.type === "chat:complete" && e.payload?.projectSlug === slug, { timeoutMs: 20_000 });

      const actives = ws
        .events
        .filter((e) => e.type === "chat:active" && e.payload?.projectSlug === slug);
      expect(actives.length).toBeGreaterThan(0);
      // No frame may announce the session idle while tasks are still listed.
      expect(actives.at(-1)!.payload!.running).toBe(true);
    } finally {
      ws.close();
    }
  }, 40_000);

  it("replays the live set to a socket that connects mid-run", async () => {
    const slug = await freshProject();
    const driver = await connectWs(port);
    let latecomer: Awaited<ReturnType<typeof connectWs>> | null = null;
    try {
      driver.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });
      await driver.waitFor(
        (e) => bgFrame(slug)(e) && ((e.payload?.tasks as unknown[]) ?? []).length === 2,
        { timeoutMs: 20_000 },
      );

      // A pane that mounts now — a reload, or navigating back — must be told what
      // is in flight without polling for it.
      latecomer = await connectWs(port);
      const replay = await latecomer.waitFor(
        (e) => bgFrame(slug)(e) && ((e.payload?.tasks as unknown[]) ?? []).length > 0,
        { timeoutMs: 20_000 },
      );
      expect((replay.payload!.tasks as { type: string }[]).length).toBeGreaterThan(0);
    } finally {
      driver.close();
      latecomer?.close();
    }
  }, 40_000);
});
