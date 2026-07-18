/**
 * Turn-provenance marker, human path (issue #261 / A1).
 *
 * A1 threads an `origin` (human/scheduled/spawned) + spawn `depth` marker through
 * the server-initiated turn machinery and persists it to a per-chat sidecar
 * (`run-provenance.json`) so #262 can depth-gate spawning and #267 can badge
 * provenance later. The spawned path is driven by the self-MCP write tools, which
 * need a real `claude` to invoke over the MCP bridge (the fake `claude` writes
 * transcripts directly and can't call MCP tools) — so it's verified with a real
 * spawned chat during QA. Here we drive the HUMAN path end-to-end against the REAL
 * FleetManager + CLI runtime and assert a human-started chat is persisted as
 * origin=human, depth=0 (the root of any future spawn tree).
 *
 * Each test uses its own project to avoid the cross-test sweep race.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: turn provenance (issue #261, human path)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Provenance ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  /** Read the persisted provenance sidecar (or {} if not written yet). */
  async function readProvenance(): Promise<Record<string, { origin: string; depth: number }>> {
    const file = path.join(t.cfg.dataDir, "run-provenance.json");
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return {};
    }
  }

  it("stamps a human-started NEW chat as origin=human, depth=0", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      const mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "hello there" },
      });

      const complete = await ws.waitFor(
        (e: WsEvent) =>
          e.type === "chat:complete" &&
          e.payload?.projectSlug === slug &&
          typeof e.payload?.sessionId === "string",
        { from: mark, timeoutMs: 20_000 },
      );
      const sid = complete.payload!.sessionId as string;

      // The stamp is awaited inside the turn's onMessage (before completion), so
      // it is durable by now; a tiny poll guards against fs write scheduling.
      let marker: { origin: string; depth: number } | undefined;
      for (let i = 0; i < 20 && !marker; i++) {
        marker = (await readProvenance())[sid];
        if (!marker) await new Promise((r) => setTimeout(r, 50));
      }
      expect(marker).toEqual({ origin: "human", depth: 0 });
    } finally {
      ws.close();
    }
  });

  it("does NOT change a chat's provenance when a human resumes it", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      // Turn 1: create the chat (stamps human/0).
      let mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "the codeword is banana" },
      });
      const first = await ws.waitFor(
        (e: WsEvent) =>
          e.type === "chat:complete" &&
          e.payload?.projectSlug === slug &&
          typeof e.payload?.sessionId === "string",
        { from: mark, timeoutMs: 20_000 },
      );
      const sid = first.payload!.sessionId as string;

      // Turn 2: resume the SAME chat. A resume must not re-stamp / clobber.
      mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: sid, message: "what was the codeword?" },
      });
      await ws.waitFor(
        (e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sid,
        { from: mark, timeoutMs: 20_000 },
      );

      expect((await readProvenance())[sid]).toEqual({ origin: "human", depth: 0 });
    } finally {
      ws.close();
    }
  });
});
