/**
 * Slash-command listing endpoints (issue #103):
 *   GET /api/projects/:slug/commands  → a project keeper's commands
 *   GET /api/commands                 → the scratch agent's commands
 *
 * The underlying `FleetManager.listAgentCommands` opens an SDK-runtime streaming
 * session and calls `supportedCommands()` — a live `claude` subprocess the fake
 * CLI stand-in can't emulate. So we spy on it: the value under test here is the
 * ROUTE wiring (agent-name resolution, 404 on unknown slug, JSON shape) and the
 * service-level memoization (one subprocess per agent, shared by repeat/burst
 * callers), not the SDK control protocol itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { SCRATCH_AGENT, keeperAgentName } from "../../src/herdctl.js";
import type { SlashCommand } from "@herdctl/core";

const FIXTURE: SlashCommand[] = [
  { name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "" },
  { name: "clear", description: "Clear conversation history", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "<pr>" },
];

describe("integration: slash-command listing endpoints (#103)", () => {
  let t: TestApp;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Cmd Proj" } });
    // Stub the live SDK-streaming call so no real `claude` subprocess is spawned;
    // installed before any request so the first call is counted.
    spy = vi
      .spyOn(t.herdctl.manager, "listAgentCommands")
      .mockResolvedValue(FIXTURE as SlashCommand[]);
  });
  afterAll(async () => {
    spy?.mockRestore();
    await t.teardown();
  });

  it("GET /api/projects/:slug/commands returns the keeper's commands", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/cmd-proj/commands" });
    expect(res.statusCode).toBe(200);
    expect(res.json().commands).toEqual(FIXTURE);
    // Resolved against the project's keeper agent, not the raw slug.
    expect(spy).toHaveBeenCalledWith(keeperAgentName("cmd-proj"));
  });

  it("memoizes per agent — a second request does not spawn another subprocess", async () => {
    const before = spy.mock.calls.length;
    await t.app.inject({ method: "GET", url: "/api/projects/cmd-proj/commands" });
    await t.app.inject({ method: "GET", url: "/api/projects/cmd-proj/commands" });
    expect(spy.mock.calls.length).toBe(before); // served from cache
  });

  it("GET /api/projects/:slug/commands 404s for an unknown project", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/ghost/commands" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/commands returns the scratch agent's commands", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/commands" });
    expect(res.statusCode).toBe(200);
    expect(res.json().commands).toEqual(FIXTURE);
    expect(spy).toHaveBeenCalledWith(SCRATCH_AGENT);
  });

  it("de-duplicates concurrent first calls into one subprocess", async () => {
    // A fresh agent name never fetched before: fire a burst and assert the
    // in-flight promise is shared (exactly one underlying call).
    const before = spy.mock.calls.length;
    await Promise.all([
      t.herdctl.listCommands("keeper-burst"),
      t.herdctl.listCommands("keeper-burst"),
      t.herdctl.listCommands("keeper-burst"),
    ]);
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it("evicts a rejected fetch so a later call retries", async () => {
    spy.mockRejectedValueOnce(new Error("boom"));
    await expect(t.herdctl.listCommands("keeper-retry")).rejects.toThrow("boom");
    // The failed promise was dropped from the cache, so this call re-invokes.
    const before = spy.mock.calls.length;
    await expect(t.herdctl.listCommands("keeper-retry")).resolves.toEqual(FIXTURE);
    expect(spy.mock.calls.length).toBe(before + 1);
  });
});
