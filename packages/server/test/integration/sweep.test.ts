/**
 * Post-turn sweep (SweepService) coverage — the overview/changelog curation
 * engine (sweep.ts), driven end-to-end through the REAL app + the fake claude.
 *
 * The fake now emits a marker-shaped sweeper reply (<<<OVERVIEW>>> …
 * <<<CHANGELOG>>> … <<<END>>>) when it sees the sweeper's curation prompt, so a
 * real sweep can run: ws.ts enqueues a sweep after a successful project turn,
 * SweepService triggers the (tool-less) sweeper, parses the markers, and writes
 * OVERVIEW.md + appends a CHANGELOG bullet.
 *
 * We set the sweep min-interval to 0 so the trailing sweep fires on the next
 * tick rather than waiting the 5-minute default; the sweep runs out-of-band, so
 * we POLL the project's overview endpoint until it's populated.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: post-turn sweep curates OVERVIEW + CHANGELOG", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    // sweepIntervalMs: 0 → the trailing sweep runs immediately after a turn.
    t = await startTestApp({ sweepIntervalMs: 0 });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Sweep Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("writes a curated OVERVIEW.md and appends a CHANGELOG bullet after a project turn", async () => {
    // A normal project chat turn — its completion enqueues a sweep.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "sweep-proj", sessionId: null, message: "let's get this project going" },
    });
    await ws.waitFor(isComplete("sweep-proj"), { from: mark });

    // The sweep runs out of band; poll the overview endpoint until it's curated.
    await vi.waitFor(
      async () => {
        const overview = (
          await t.app.inject({ method: "GET", url: "/api/projects/sweep-proj/overview" })
        ).body;
        expect(overview).toContain("# Project Overview");
      },
      { timeout: 15_000, interval: 200 },
    );

    // CHANGELOG.md gained the sweeper's single curated bullet (under a dated
    // heading appendChangelog adds), in addition to the seeded "Project opened.".
    const changelog = (
      await t.app.inject({ method: "GET", url: "/api/projects/sweep-proj/changelog" })
    ).body;
    expect(changelog).toContain("Curated recent chat activity into the overview.");
    expect(changelog).toContain("Project opened.");

    // hasOverview now reflects on the project DTO.
    const project = (
      await t.app.inject({ method: "GET", url: "/api/projects/sweep-proj" })
    ).json().project;
    expect(project.hasOverview).toBe(true);

    // CLAUDE.md (issue #177): seeded at creation, then AMENDED by the sweep with
    // the fake's <<<CLAUDE>>> durable note under a "Curated notes" heading — the
    // seed header (identity) is preserved above it (amend-only, no clobber).
    const claude = await fs.readFile(path.join(project.dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# Sweep Proj");
    expect(claude).toContain("## Curated notes");
    expect(claude).toContain("A durable convention discovered from recent activity.");
  });

  it("does NOT sweep scratch chats", async () => {
    const enqueueSpy = vi.spyOn(t.sweep, "enqueue");
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "scratch", sessionId: null, message: "scratch turn, no sweep" },
    });
    await ws.waitFor(isComplete("scratch"), { from: mark });
    // enqueue is never called for the scratch slug.
    const sweptSlugs = enqueueSpy.mock.calls.map((c) => c[0]);
    expect(sweptSlugs).not.toContain("scratch");
    enqueueSpy.mockRestore();
  });
});
