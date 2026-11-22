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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

const READER = "pdk_testinstance_reader00000000000000000000";

describe("integration: WS background-work signal (#604)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "[[BGTASK]] go": "Kicked off some background work." },
      sweepIntervalMs: 600_000,
      // The management API is only here so `list_chats` can be asserted on.
      configFile: {
        managementApi: {
          publicUrl: "https://paddock.example.test",
          clients: { reader: { auth: { ref: "env:MCP_READER" } } },
        },
      },
      env: { PADDOCK_FAKE_BGTASK_MS: "1500", MCP_READER: READER, PADDOCK_AUTH_MODE: "none" },
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

  /**
   * A chat whose turn has ended but whose background work is still live must
   * read as running everywhere a newcomer looks. Before this, the connect-time
   * catch-up sent `chat:active` only for running TURNS, so a reloaded page lost
   * the sidebar dot; `list_chats` and the attention feed asked the hub alone.
   */
  it("reports a turn-ended, background-busy chat as running to a newcomer", async () => {
    const slug = await freshProject();
    const driver = await connectWs(port);
    let latecomer: Awaited<ReturnType<typeof connectWs>> | null = null;
    try {
      driver.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });
      const done = await driver.waitFor(
        (e) => e.type === "chat:complete" && e.payload?.projectSlug === slug,
        { timeoutMs: 20_000 },
      );
      const sessionId = done.payload!.sessionId as string;
      // The monitor outlives the turn, so the set is non-empty from here on.
      expect(driver.events.filter(bgFrame(slug)).at(-1)!.payload!.tasks).not.toHaveLength(0);

      latecomer = await connectWs(port);
      const active = await latecomer.waitFor(
        (e) => e.type === "chat:active" && e.payload?.sessionId === sessionId,
        { timeoutMs: 5_000 },
      );
      expect(active.payload).toMatchObject({ projectSlug: slug, running: true, turnRunning: false });

      const attention = (
        await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/attention` })
      ).json();
      expect(attention.running.map((c: { sessionId: string }) => c.sessionId)).toEqual([sessionId]);

      const res = await t.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${READER}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_chats", arguments: { project: slug } },
        },
      });
      const line = res.body.split("\n").find((l) => l.startsWith("data: "))!;
      const listed = JSON.parse(JSON.parse(line.slice("data: ".length)).result.content[0].text);
      expect(listed.chats).toEqual([expect.objectContaining({ sessionId, running: true })]);
    } finally {
      driver.close();
      latecomer?.close();
    }
  }, 40_000);

  it("tells a socket that connects after the turn ended that the chat is still busy", async () => {
    const slug = await freshProject();
    const driver = await connectWs(port);
    let latecomer: Awaited<ReturnType<typeof connectWs>> | null = null;
    // The fake runs the CLI runtime, which has no managed session, so a stop
    // answers `gone` and the server drops the row itself. Pinned to `false` so
    // that holds however the fleet is wired.
    const fleet = (t.herdctl as unknown as { fleet: Record<string, unknown> }).fleet;
    const prevStop = fleet.stopTaskInSession;
    fleet.stopTaskInSession = vi.fn(async () => false);
    try {
      driver.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" } });
      // The turn is over, and the monitor outlives it.
      await driver.waitFor(
        (e) =>
          e.type === "chat:active" &&
          e.payload?.projectSlug === slug &&
          e.payload?.turnRunning === false,
        { timeoutMs: 20_000 },
      );

      // A reload: this socket saw none of the live frames, only the replay.
      latecomer = await connectWs(port);
      const replay = await latecomer.waitFor(
        (e) => e.type === "chat:active" && e.payload?.projectSlug === slug,
        { timeoutMs: 20_000 },
      );
      expect(replay.payload).toMatchObject({ running: true, turnRunning: false, jobId: null });
      const sessionId = replay.payload!.sessionId as string;
      const bg = await latecomer.waitFor(
        (e) => bgFrame(slug)(e) && ((e.payload?.tasks as unknown[]) ?? []).length > 0,
        { timeoutMs: 20_000 },
      );
      const monitor = (bg.payload!.tasks as { id: string; role: string }[]).find(
        (x) => x.role === "monitor",
      )!;

      // The last task leaves, and the fresh socket is told the chat is idle.
      // `lastPublishedRunning` is shared across sockets, so this is the flip a
      // replay-only socket would miss if the replay had not counted as published.
      const mark = latecomer.mark();
      driver.send({ type: "chat:stop_task", payload: { sessionId, taskId: monitor.id } });
      const idle = await latecomer.waitFor(
        (e) => e.type === "chat:active" && e.payload?.sessionId === sessionId,
        { from: mark, timeoutMs: 20_000 },
      );
      expect(idle.payload).toMatchObject({ running: false, turnRunning: false });
    } finally {
      fleet.stopTaskInSession = prevStop;
      driver.close();
      latecomer?.close();
    }
  }, 40_000);
});
