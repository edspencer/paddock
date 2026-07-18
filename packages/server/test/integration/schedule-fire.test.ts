/**
 * Scheduled chat sessions, server side (issue #265 / D3).
 *
 * Drives the WHOLE seam against the REAL @herdctl/core FleetManager + scheduler +
 * CLI runtime (fake `claude`, no Anthropic calls): a schedule armed on a project's
 * keeper agent fires through herdctl's cron engine, routes to Paddock's registered
 * `scheduleTriggerHandler`, and runs a real keeper turn on Paddock's OWN hub via
 * `startAgentTurn` with `origin: scheduled` — so the run is a first-class,
 * discoverable Paddock chat (never `isSidechain`-hidden).
 *
 * A freshly-armed interval schedule with NO prior run is due immediately
 * (`calculateNextTrigger(null) === now`), so an interval like `"1h"` fires exactly
 * ONCE at arm time and not again for an hour — deterministic, no runaway fires.
 * We force a controlled SECOND fire by remove+re-add (which prunes herdctl state,
 * so the re-armed schedule is again immediately due) to prove new-vs-accrete.
 *
 * Requires the per-deployment mutation gate (`PADDOCK_SCHEDULE_MUTATION=1`) so the
 * test can arm schedules via `setAgentSchedule`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { isScheduleMutationDisabledError } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type DtoChat = { sessionId: string; provenance?: { origin: string; depth: number } };

async function poll<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  { timeoutMs = 20_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Date.now() is fine in tests; this is wall-clock polling, not a workflow.
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("integration: scheduled chats (issue #265)", () => {
  let t: TestApp;
  let savedGate: string | undefined;
  let n = 0;

  beforeAll(async () => {
    savedGate = process.env.PADDOCK_SCHEDULE_MUTATION;
    process.env.PADDOCK_SCHEDULE_MUTATION = "1";
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
    if (savedGate === undefined) delete process.env.PADDOCK_SCHEDULE_MUTATION;
    else process.env.PADDOCK_SCHEDULE_MUTATION = savedGate;
  });

  async function freshProject(): Promise<Project> {
    const name = `Sched ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { project: Project }).project;
  }

  async function scheduledChats(slug: string): Promise<DtoChat[]> {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })).json()
      .chats as DtoChat[];
    return chats.filter((c) => c.provenance?.origin === "scheduled");
  }

  async function readOwned(slug: string, name: string): Promise<string | undefined> {
    const file = path.join(t.cfg.dataDir, "schedule-sessions.json");
    try {
      return (JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>)[
        `${slug}\0${name}`
      ];
    } catch {
      return undefined;
    }
  }

  it("arms + fires a schedule → a scheduled chat appears on the hub (origin scheduled, depth 0)", async () => {
    const project = await freshProject();
    // Arm a one-shot-per-hour schedule: fires immediately, then not again.
    await t.herdctl.setAgentSchedule(project, "tick", {
      type: "interval",
      interval: "1h",
      prompt: "run the scheduled job",
      enabled: true,
      resume_session: false,
    });

    const found = await poll(
      () => scheduledChats(project.slug),
      (chats) => chats.length >= 1,
    );
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]!.provenance).toEqual({ origin: "scheduled", depth: 0 });

    // Provenance is durable in the sidecar too.
    const persisted = JSON.parse(
      await fs.readFile(path.join(t.cfg.dataDir, "run-provenance.json"), "utf8"),
    ) as Record<string, { origin: string; depth: number }>;
    expect(persisted[found[0]!.sessionId]).toEqual({ origin: "scheduled", depth: 0 });

    // Stop further fires from this schedule interfering with later assertions.
    await t.herdctl.removeAgentSchedule(project, "tick");
  });

  it("resume_session:false starts a NEW chat each fire; true reuses ONE owned session", async () => {
    // --- resume_session:false: two fires → two distinct scheduled chats ---
    const fresh = await freshProject();
    const armFalse = () =>
      t.herdctl.setAgentSchedule(fresh, "tick", {
        type: "interval",
        interval: "1h",
        prompt: "fresh each time",
        resume_session: false,
      });
    await armFalse();
    await poll(() => scheduledChats(fresh.slug), (c) => c.length >= 1);
    // Force a controlled second fire.
    await t.herdctl.removeAgentSchedule(fresh, "tick");
    await armFalse();
    const twoFresh = await poll(() => scheduledChats(fresh.slug), (c) => c.length >= 2);
    await t.herdctl.removeAgentSchedule(fresh, "tick");
    expect(twoFresh.length).toBeGreaterThanOrEqual(2);
    // All are origin scheduled, depth 0.
    for (const c of twoFresh) expect(c.provenance).toEqual({ origin: "scheduled", depth: 0 });

    // --- resume_session:true: two fires → ONE owned session, reused ---
    const accr = await freshProject();
    const armTrue = () =>
      t.herdctl.setAgentSchedule(accr, "mgr", {
        type: "interval",
        interval: "1h",
        prompt: "accrete into one transcript",
        resume_session: true,
      });
    await armTrue();
    const firstOwned = await poll(
      () => readOwned(accr.slug, "mgr"),
      (v) => typeof v === "string",
    );
    expect(typeof firstOwned).toBe("string");
    // The owned id IS the one scheduled chat.
    const oneChat = await poll(() => scheduledChats(accr.slug), (c) => c.length >= 1);
    expect(oneChat.map((c) => c.sessionId)).toContain(firstOwned);

    // Wait for that first turn to settle (not running) before forcing a 2nd fire,
    // so the resume discovers the owned transcript cleanly.
    await poll(
      () => t.app.inject({ method: "GET", url: `/api/projects/${accr.slug}/chats` }).then((r) => r.json().chats as (DtoChat & { running?: boolean })[]),
      (chats) => chats.some((c) => c.sessionId === firstOwned && !c.running),
    );

    // Force a second fire: it must RESUME the owned session, not create a new one.
    await t.herdctl.removeAgentSchedule(accr, "mgr");
    await armTrue();
    // Give the scheduler a few ticks to fire the second run.
    await new Promise((r) => setTimeout(r, 4000));
    const afterSecond = await scheduledChats(accr.slug);
    await t.herdctl.removeAgentSchedule(accr, "mgr");
    // Still exactly the ONE owned chat — the accreting schedule reused it.
    expect(afterSecond.map((c) => c.sessionId)).toEqual([firstOwned]);
    expect(await readOwned(accr.slug, "mgr")).toBe(firstOwned);
  });

  it("forwards project.yaml schedules UNMOLESTED into the keeper agent config (armed by herdctl)", async () => {
    const project = await freshProject();
    // Declare a schedule in project.yaml, then re-register the keeper from it: the
    // config-build path (keeperAgentConfig → schedules block) must arm it in
    // herdctl's own scheduler — no mutation API involved.
    const yamlPath = path.join(t.projectsRoot, project.slug, "project.yaml");
    const parsed = YAML.parse(await fs.readFile(yamlPath, "utf8")) as Record<string, unknown>;
    parsed.schedules = {
      declared: { type: "cron", cron: "0 9 * * *", prompt: "morning triage", enabled: false },
    };
    await fs.writeFile(yamlPath, YAML.stringify(parsed), "utf8");

    const fresh = (
      await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}` })
    ).json().project as Project;
    await t.herdctl.ensureProjectAgent(fresh);

    const armed = (await t.herdctl.manager.getSchedules()).find(
      (s) => s.agentName === `keeper-${project.slug}` && s.name === "declared",
    );
    expect(armed).toBeTruthy();
  });

  it("promptFile sugar: reads .paddock/schedules/*.md at fire time as the prompt", async () => {
    const project = await freshProject();
    // Write the keeper-editable prompt file and persist a promptFile-driven
    // schedule into project.yaml (so projects.get() returns it with promptFile).
    const promptBody = "SCHEDULED PROMPT FROM FILE — codeword pineapple";
    const dir = path.join(t.projectsRoot, project.slug, ".paddock", "schedules");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "greet.md"), promptBody, "utf8");

    const yamlPath = path.join(t.projectsRoot, project.slug, "project.yaml");
    const parsed = YAML.parse(await fs.readFile(yamlPath, "utf8")) as Record<string, unknown>;
    parsed.schedules = {
      greet: { type: "interval", interval: "1h", promptFile: "greet.md", resume_session: false },
    };
    await fs.writeFile(yamlPath, YAML.stringify(parsed), "utf8");

    // Arm the herdctl side with NO prompt (promptFile is Paddock-only): the handler
    // must resolve the prompt from the file at fire time.
    await t.herdctl.setAgentSchedule(project, "greet", {
      type: "interval",
      interval: "1h",
      resume_session: false,
    });

    const chats = await poll(
      () => scheduledChats(project.slug),
      (c) => c.length >= 1,
    );
    await t.herdctl.removeAgentSchedule(project, "greet");
    expect(chats.length).toBeGreaterThanOrEqual(1);
    const sid = chats[0]!.sessionId;

    // The turn's user message is the prompt herdctl ran — the fake `claude` echoes
    // it verbatim into the transcript, so the file content must appear there.
    const msgs = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/${project.slug}/chats/${sid}/messages`,
      })
    ).json().messages as { role: string; content: string }[];
    const userText = msgs.find((m) => m.role === "user")?.content ?? "";
    expect(userText).toContain(promptBody);
  });

  it("gates schedule mutation OFF when the deployment opts out", async () => {
    // A separate app with the gate DISABLED — setAgentSchedule must throw.
    const savedInner = process.env.PADDOCK_SCHEDULE_MUTATION;
    delete process.env.PADDOCK_SCHEDULE_MUTATION;
    const off = await startTestApp({ sweepIntervalMs: 600_000 });
    try {
      const res = await off.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Gated" },
      });
      const project = (res.json() as { project: Project }).project;
      const err = await off.herdctl
        .setAgentSchedule(project, "tick", { type: "interval", interval: "1h" })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeNull();
      expect(isScheduleMutationDisabledError(err)).toBe(true);
    } finally {
      await off.teardown();
      if (savedInner === undefined) delete process.env.PADDOCK_SCHEDULE_MUTATION;
      else process.env.PADDOCK_SCHEDULE_MUTATION = savedInner;
    }
  });
});
