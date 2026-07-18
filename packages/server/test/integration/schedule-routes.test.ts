/**
 * Per-project schedules management API (issue #266 / D4).
 *
 * Drives the HTTP surface the Settings pane calls against the REAL app +
 * @herdctl/core FleetManager + scheduler + CLI runtime (fake `claude`): list,
 * create/replace, edit, enable/disable, delete, and "trigger now". Trigger-now
 * routes through the SAME `startAgentTurn` hub path a cron fire uses (D3), so the
 * resulting run is a first-class, discoverable, `scheduled`-badged chat.
 *
 * The mutating routes are gated behind the per-deployment mutation flag
 * (`PADDOCK_SCHEDULE_MUTATION`); the final block proves the gate returns 403 for
 * edits while GET stays available (read-only) and trigger-now still fires a
 * statically-declared schedule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type ScheduleDto = {
  name: string;
  type: string;
  cron: string | null;
  interval: string | null;
  prompt: string | null;
  promptFile: string | null;
  resumeSession: boolean;
  enabled: boolean;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
};
type DtoChat = { sessionId: string; provenance?: { origin: string; depth: number } };

async function poll<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  { timeoutMs = 20_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("integration: schedules management API (issue #266)", () => {
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
    const name = `SchedUI ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { project: Project }).project;
  }

  async function list(slug: string): Promise<{ schedules: ScheduleDto[]; mutationEnabled: boolean }> {
    return (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/schedules` })).json();
  }

  async function scheduledChats(slug: string): Promise<DtoChat[]> {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })).json()
      .chats as DtoChat[];
    return chats.filter((c) => c.provenance?.origin === "scheduled");
  }

  it("lists an empty set + surfaces the mutation gate", async () => {
    const project = await freshProject();
    const r = await list(project.slug);
    expect(r.schedules).toEqual([]);
    expect(r.mutationEnabled).toBe(true);
  });

  it("creates → lists (armed, with runtime state) → edits → deletes a schedule", async () => {
    const project = await freshProject();

    // Create.
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/daily`,
      payload: { type: "cron", cron: "0 9 * * *", prompt: "morning triage", resume_session: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().schedule.name).toBe("daily");

    // It persisted to project.yaml (herdctl ScheduleSchema shape, promptFile absent).
    const yaml = YAML.parse(
      await fs.readFile(path.join(t.projectsRoot, project.slug, "project.yaml"), "utf8"),
    ) as { schedules?: Record<string, Record<string, unknown>> };
    expect(yaml.schedules?.daily).toMatchObject({
      type: "cron",
      cron: "0 9 * * *",
      prompt: "morning triage",
      resume_session: true,
    });

    // Listed, merged with herdctl's live runtime state. A not-yet-due cron has
    // never run, so herdctl reports status idle and null last/next run (next_run_at
    // is only persisted after a fire) — the merge still sources `status` from the
    // live ScheduleInfo, proving the declaration + runtime join.
    const listed = (await list(project.slug)).schedules;
    expect(listed).toHaveLength(1);
    const dto = listed[0]!;
    expect(dto).toMatchObject({
      name: "daily",
      type: "cron",
      cron: "0 9 * * *",
      resumeSession: true,
      enabled: true,
      status: "idle",
    });
    expect(dto.lastRunAt).toBeNull();

    // Edit: switch to an interval + a new prompt.
    const edit = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/daily`,
      payload: { type: "interval", interval: "6h", prompt: "changed", resume_session: false },
    });
    expect(edit.statusCode).toBe(200);
    const afterEdit = (await list(project.slug)).schedules[0]!;
    expect(afterEdit).toMatchObject({ type: "interval", interval: "6h", resumeSession: false });
    expect(afterEdit.cron).toBeNull();

    // Delete: gone from the API AND from herdctl's armed set.
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.slug}/schedules/daily`,
    });
    expect(del.statusCode).toBe(200);
    expect((await list(project.slug)).schedules).toEqual([]);
    const armed = (await t.herdctl.manager.getSchedules()).filter(
      (s) => s.agentName === `keeper-${project.slug}`,
    );
    expect(armed).toEqual([]);
  });

  it("enable/disable flips status + persists the flag", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/tick`,
      payload: { type: "interval", interval: "1h", prompt: "x" },
    });

    // Disable.
    const off = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/schedules/tick/disable`,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().schedule.enabled).toBe(false);
    expect(off.json().schedule.status).toBe("disabled");
    let dto = (await list(project.slug)).schedules[0]!;
    expect(dto.enabled).toBe(false);

    // Enable.
    const on = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/schedules/tick/enable`,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().schedule.enabled).toBe(true);
    dto = (await list(project.slug)).schedules[0]!;
    expect(dto.enabled).toBe(true);
    expect(dto.status).not.toBe("disabled");

    await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.slug}/schedules/tick`,
    });
  });

  it("rejects an invalid name (400) and a malformed definition (400)", async () => {
    const project = await freshProject();
    const badName = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/${encodeURIComponent("bad name!")}`,
      payload: { type: "interval", interval: "1h", prompt: "x" },
    });
    expect(badName.statusCode).toBe(400);

    const badDef = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/ok`,
      payload: { type: "cron", prompt: "x" }, // cron type with no cron expression
    });
    expect(badDef.statusCode).toBe(400);
  });

  it("trigger-now fires the schedule → a scheduled chat appears", async () => {
    const project = await freshProject();
    // A disabled schedule: proves a MANUAL trigger fires regardless of enabled.
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/schedules/manual`,
      payload: { type: "cron", cron: "0 0 1 1 *", prompt: "run me now", enabled: false },
    });

    const trig = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/schedules/manual/trigger`,
    });
    expect(trig.statusCode).toBe(202);
    const { sessionId } = trig.json() as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    const chats = await poll(() => scheduledChats(project.slug), (c) => c.length >= 1);
    expect(chats.map((c) => c.sessionId)).toContain(sessionId);
    expect(chats[0]!.provenance).toEqual({ origin: "scheduled", depth: 0 });

    // Per-MESSAGE provenance (#290): the schedule-injected kickoff turn carries a
    // `schedule` sender in the message DTO — proving the record→join→DTO path (the
    // per-message analog of the `scheduled` chat badge above).
    type DtoMsg = { role: string; content: string; sender?: { kind: string; name?: string } };
    const msgs = await poll(
      async () => {
        const r = await t.app.inject({
          method: "GET",
          url: `/api/projects/${project.slug}/chats/${sessionId}/messages`,
        });
        return (r.json() as { messages: DtoMsg[] }).messages;
      },
      (ms) => ms.some((m) => m.role === "user" && m.content.includes("run me now")),
    );
    const injected = msgs.find((m) => m.role === "user" && m.content.includes("run me now"));
    expect(injected?.sender).toEqual({ kind: "schedule", name: "manual", project: project.slug });

    // A trigger for a schedule that doesn't exist is a 404.
    const missing = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/schedules/nope/trigger`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("gate OFF: edits are 403, but GET is read-only-available and trigger-now still fires", async () => {
    const savedInner = process.env.PADDOCK_SCHEDULE_MUTATION;
    delete process.env.PADDOCK_SCHEDULE_MUTATION;
    const off = await startTestApp({ sweepIntervalMs: 600_000 });
    try {
      const project = (
        await off.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Gated UI" } })
      ).json().project as Project;

      // Statically declare a schedule in project.yaml and re-register the keeper
      // (allowed regardless of the gate) so there IS something to read + trigger.
      const yamlPath = path.join(off.projectsRoot, project.slug, "project.yaml");
      const parsed = YAML.parse(await fs.readFile(yamlPath, "utf8")) as Record<string, unknown>;
      parsed.schedules = {
        declared: { type: "interval", interval: "1h", prompt: "static", enabled: true },
      };
      await fs.writeFile(yamlPath, YAML.stringify(parsed), "utf8");
      const fresh = (
        await off.app.inject({ method: "GET", url: `/api/projects/${project.slug}` })
      ).json().project as Project;
      await off.herdctl.ensureProjectAgent(fresh);

      // GET works, reports the gate closed.
      const r = (
        await off.app.inject({ method: "GET", url: `/api/projects/${project.slug}/schedules` })
      ).json() as { schedules: ScheduleDto[]; mutationEnabled: boolean };
      expect(r.mutationEnabled).toBe(false);
      expect(r.schedules.map((s) => s.name)).toContain("declared");

      // Mutations are 403.
      for (const req of [
        { method: "PUT" as const, url: `/api/projects/${project.slug}/schedules/x`, payload: { type: "interval", interval: "1h", prompt: "x" } },
        { method: "DELETE" as const, url: `/api/projects/${project.slug}/schedules/declared` },
        { method: "POST" as const, url: `/api/projects/${project.slug}/schedules/declared/disable` },
      ]) {
        const res = await off.app.inject(req);
        expect(res.statusCode).toBe(403);
      }

      // Trigger-now bypasses the gate (it runs a declared schedule, doesn't mutate).
      const trig = await off.app.inject({
        method: "POST",
        url: `/api/projects/${project.slug}/schedules/declared/trigger`,
      });
      expect(trig.statusCode).toBe(202);
    } finally {
      await off.teardown();
      if (savedInner === undefined) delete process.env.PADDOCK_SCHEDULE_MUTATION;
      else process.env.PADDOCK_SCHEDULE_MUTATION = savedInner;
    }
  });
});
