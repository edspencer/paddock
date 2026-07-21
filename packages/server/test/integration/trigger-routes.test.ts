/**
 * Per-project UNIFIED trigger management API (Epic T "Unify Triggers" / T3 —
 * Triggers tab surface).
 *
 * Drives the HTTP surface that collapses the paired hooks + schedules REST onto ONE
 * `TriggerService` over `project.yaml`'s single `triggers` block, against the REAL
 * app + @herdctl/core FleetManager: list (with the picker catalog), create/replace,
 * enable/disable (which is just `set` with `enabled` flipped — GG-3), and delete.
 * Each mutation persists to project.yaml (source of truth) AND arms herdctl — an
 * EVENT trigger's OWN agent `trigger-<slug>-<name>` whose tool config IS its
 * capability, a SCHEDULE trigger's forwarded `schedules` entry — so the test asserts
 * both the persisted YAML and, for event triggers, the live agent's `allowed_tools`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";
import { triggerAgentName } from "../../src/herdctl.js";

type TriggerDto = {
  name: string;
  agentName: string;
  trigger: { type: string; cron?: string; interval?: string; on?: string; path?: string };
  run: {
    prompt?: string;
    promptFile?: string;
    session: string;
    tools: string[];
    model?: string;
    permissionMode?: string;
    maxSpawnDepth?: number;
    maxTurns?: number;
  };
  enabled: boolean;
};

type ListResp = {
  triggers: TriggerDto[];
  grantableTools: { name: string; group: string; description: string }[];
  events: string[];
  triggerTypes: string[];
};

describe("integration: unified triggers management API (Epic T / T3)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<Project> {
    const name = `TriggersUI ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { project: Project }).project;
  }

  async function list(slug: string): Promise<ListResp> {
    return (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/triggers` })).json();
  }

  /** The event trigger's live agent as the fleet resolved it (or undefined). */
  function armedAgent(slug: string, name: string) {
    return t.herdctl.manager
      .getAgents()
      .find((a) => a.name === triggerAgentName(slug, name)) as
      | { name: string; allowed_tools?: string[]; max_turns?: number; permission_mode?: string }
      | undefined;
  }

  async function readYaml(slug: string) {
    return YAML.parse(
      await fs.readFile(path.join(t.projectsRoot, slug, "project.yaml"), "utf8"),
    ) as { triggers?: Record<string, Record<string, unknown>> };
  }

  it("lists an empty set + surfaces the picker catalog (tools + events + types)", async () => {
    const project = await freshProject();
    const r = await list(project.slug);
    expect(r.triggers).toEqual([]);
    // The capability picker's catalog is served with the list so the UI never
    // hard-codes the tool set — folds in the G4 GRANTABLE_TOOLS list.
    expect(r.grantableTools.map((tl) => tl.name)).toEqual(
      expect.arrayContaining(["Read", "Write", "Bash"]),
    );
    expect(r.events).toContain("onArchive");
    expect(r.triggerTypes).toEqual(expect.arrayContaining(["schedule", "event", "webhook"]));
  });

  it("creates an EVENT trigger → persists YAML + arms the agent → edits → deletes", async () => {
    const project = await freshProject();

    // Create: a cleanup EVENT trigger granted Bash, disabled by default.
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/cleanup`,
      payload: {
        trigger: { type: "event", on: "onArchive" },
        run: { prompt: "spin down any pm servers this chat started", tools: ["Bash", "Read"], permissionMode: "acceptEdits", maxTurns: 12 },
        enabled: false,
      },
    });
    expect(put.statusCode).toBe(200);
    const created = put.json().trigger as TriggerDto;
    expect(created.name).toBe("cleanup");
    expect(created.agentName).toBe(triggerAgentName(project.slug, "cleanup"));
    expect(created.enabled).toBe(false);
    expect(created.trigger).toMatchObject({ type: "event", on: "onArchive" });

    // Persisted to project.yaml under the single `triggers` map.
    const yaml = await readYaml(project.slug);
    expect(yaml.triggers?.cleanup).toMatchObject({
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "spin down any pm servers this chat started", tools: ["Bash", "Read"] },
      enabled: false,
    });

    // The event trigger's OWN agent is armed, and its tool config IS the capability:
    // allowed_tools == exactly the granted set, max_turns + permission_mode applied.
    const agent = armedAgent(project.slug, "cleanup");
    expect(agent).toBeDefined();
    expect(agent!.allowed_tools).toEqual(["Bash", "Read"]);
    expect(agent!.max_turns).toBe(12);
    expect(agent!.permission_mode).toBe("acceptEdits");

    // Listed back as a DTO.
    const listed = (await list(project.slug)).triggers;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "cleanup",
      trigger: { type: "event", on: "onArchive" },
      enabled: false,
    });

    // Edit: switch to a tool-less trigger (no tools) → allowed_tools becomes [].
    const edit = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/cleanup`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "just think" }, enabled: false },
    });
    expect(edit.statusCode).toBe(200);
    expect(armedAgent(project.slug, "cleanup")!.allowed_tools).toEqual([]);

    // Delete: gone from the API AND from the fleet's agent set.
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.slug}/triggers/cleanup`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, name: "cleanup", removed: true });
    expect((await list(project.slug)).triggers).toEqual([]);
    expect(armedAgent(project.slug, "cleanup")).toBeUndefined();
  });

  it("creates a SCHEDULE trigger → persists YAML + routes per T2 (scoped vs keeper)", async () => {
    const project = await freshProject();

    // A SCOPED schedule (non-empty run.tools) runs on its OWN agent (T2's
    // triggerRunsOnOwnAgent) — the REST route delegates to TriggerService, which
    // inherits that routing, so the surface is a superset of T2.
    const scoped = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/daily`,
      payload: {
        trigger: { type: "schedule", cron: "0 9 * * *" },
        run: { promptFile: "daily.md", session: "resume", tools: ["Read"] },
        enabled: true,
      },
    });
    expect(scoped.statusCode).toBe(200);
    const dto = scoped.json().trigger as TriggerDto;
    expect(dto.trigger).toMatchObject({ type: "schedule", cron: "0 9 * * *" });
    expect(dto.run).toMatchObject({ promptFile: "daily.md", session: "resume" });

    const yaml = await readYaml(project.slug);
    expect(yaml.triggers?.daily).toMatchObject({
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { promptFile: "daily.md", session: "resume", tools: ["Read"] },
      enabled: true,
    });
    // Scoped schedule → its own agent armed, tool config == the grant (T2).
    const agent = armedAgent(project.slug, "daily");
    expect(agent).toBeDefined();
    expect(agent!.allowed_tools).toEqual(["Read"]);

    // A TOOL-LESS schedule runs as the keeper (forwarded schedule) — no own agent.
    const keeperRun = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/nightly`,
      payload: {
        trigger: { type: "schedule", interval: "1h" },
        run: { prompt: "curate", tools: [] },
        enabled: true,
      },
    });
    expect(keeperRun.statusCode).toBe(200);
    expect(armedAgent(project.slug, "nightly")).toBeUndefined();

    // Delete the scoped one → its agent is torn down.
    await t.app.inject({ method: "DELETE", url: `/api/projects/${project.slug}/triggers/daily` });
    expect(armedAgent(project.slug, "daily")).toBeUndefined();
  });

  it("enable/disable is a `set` with `enabled` flipped (no separate verb)", async () => {
    const project = await freshProject();
    const body = { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" } };
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/tick`,
      payload: { ...body, enabled: false },
    });

    const on = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/tick`,
      payload: { ...body, enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().trigger.enabled).toBe(true);
    expect((await list(project.slug)).triggers[0]!.enabled).toBe(true);

    const off = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/tick`,
      payload: { ...body, enabled: false },
    });
    expect(off.json().trigger.enabled).toBe(false);
  });

  it("GET one trigger returns it; 404s an unknown name", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/one`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "hi" } },
    });
    const ok = await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/triggers/one` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trigger.name).toBe("one");
    const miss = await t.app.inject({
      method: "GET",
      url: `/api/projects/${project.slug}/triggers/nope`,
    });
    expect(miss.statusCode).toBe(404);
  });

  it("rejects a malformed trigger (bad discriminant / both prompt+promptFile) and a bad name", async () => {
    const project = await freshProject();
    // Unknown event value.
    const badEvent = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/x`,
      payload: { trigger: { type: "event", on: "onNope" }, run: { prompt: "y" } },
    });
    expect(badEvent.statusCode).toBe(400);

    // Both prompt AND promptFile (the run xor is rejected).
    const bothPrompts = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/x`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "y", promptFile: "z.md" } },
    });
    expect(bothPrompts.statusCode).toBe(400);

    // Schedule with neither cron nor interval.
    const noTimer = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/x`,
      payload: { trigger: { type: "schedule" }, run: { prompt: "y" } },
    });
    expect(noTimer.statusCode).toBe(400);

    const badName = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/bad%20name`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "y" } },
    });
    expect(badName.statusCode).toBe(400);
  });

  it("404s triggers on an unknown project", async () => {
    const r = await t.app.inject({ method: "GET", url: `/api/projects/does-not-exist/triggers` });
    expect(r.statusCode).toBe(404);
  });

  // --- Run-now + runtime status (#327) ------------------------------------------

  it("GET …/triggers/runtime returns a per-trigger runtime row (next-run for schedules)", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/daily`,
      payload: { trigger: { type: "schedule", cron: "0 9 * * *" }, run: { prompt: "curate" }, enabled: true },
    });
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/cleanup`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "tidy" }, enabled: true },
    });

    const r = await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/triggers/runtime` });
    expect(r.statusCode).toBe(200);
    const runtime = r.json().runtime as {
      name: string;
      type: string;
      running: boolean;
      nextRunAt: string | null;
      scheduleStatus: string | null;
    }[];
    const byName = Object.fromEntries(runtime.map((x) => [x.name, x]));
    // The schedule trigger's next-fire is populated by herdctl's cron engine; an event
    // trigger has no scheduled fire.
    expect(byName.daily.type).toBe("schedule");
    expect(byName.daily.scheduleStatus).not.toBeNull();
    expect(byName.cleanup.type).toBe("event");
    expect(byName.cleanup.nextRunAt).toBeNull();
  });

  it("the runtime route is matched before /:name (a trigger can't shadow it)", async () => {
    const project = await freshProject();
    // Even with a real trigger present, GET …/triggers/runtime hits the runtime route,
    // not GET …/triggers/:name — so it returns the { runtime } payload, not a trigger.
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/whatever`,
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "x" } },
    });
    const r = await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/triggers/runtime` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty("runtime");
    expect(r.json()).not.toHaveProperty("trigger");
  });

  it("POST …/triggers/:name/run fires an event trigger and returns 202 + a session id", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/triggers/run-me`,
      // Disabled on purpose: a manual run is deliberate and fires regardless (DD-1).
      payload: { trigger: { type: "event", on: "onArchive" }, run: { prompt: "manual run please" }, enabled: false },
    });

    const run = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/triggers/run-me/run`,
      payload: {},
    });
    expect(run.statusCode).toBe(202);
    const body = run.json() as { ok: boolean; name: string; sessionId: string };
    expect(body).toMatchObject({ ok: true, name: "run-me" });
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);

    // The fired turn ran on the trigger's own agent with the trigger's prompt.
    const msgs = await t.herdctl.sessionMessages(
      triggerAgentName(project.slug, "run-me"),
      body.sessionId,
    );
    const userText = msgs
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(userText).toContain("manual run please");
  });

  it("POST …/triggers/:name/run 404s an unknown trigger", async () => {
    const project = await freshProject();
    const run = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/triggers/nope/run`,
      payload: {},
    });
    expect(run.statusCode).toBe(404);
  });
});
