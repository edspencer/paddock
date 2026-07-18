/**
 * Per-project hooks management API (Epic G / G4 — Hooks tab).
 *
 * Drives the HTTP surface the Hooks tab calls against the REAL app + @herdctl/core
 * FleetManager: list (with the picker catalog), create/replace, edit, enable/disable
 * (which is just `set` with `enabled` flipped — GG-3), and delete. Each mutation
 * persists to project.yaml (source of truth) AND (de)registers the hook's own herdctl
 * agent `hook-<slug>-<name>` whose tool config IS its capability (GG-1) — so the test
 * asserts both the persisted YAML and the live agent's `allowed_tools`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";
import { hookAgentName } from "../../src/herdctl.js";

type HookDto = {
  name: string;
  agentName: string;
  event: string;
  capabilities?: {
    allowedTools?: string[];
    deniedTools?: string[];
    permissionMode?: string;
    model?: string;
    maxTurns?: number;
  };
  prompt?: string;
  promptFile?: string;
  enabled?: boolean;
};

type ListResp = {
  hooks: HookDto[];
  grantableTools: { name: string; group: string; description: string }[];
  events: string[];
};

describe("integration: hooks management API (Epic G / G4)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<Project> {
    const name = `HooksUI ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { project: Project }).project;
  }

  async function list(slug: string): Promise<ListResp> {
    return (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/hooks` })).json();
  }

  /** The hook agent as the live fleet resolved it (or undefined if unregistered). */
  function armedAgent(slug: string, name: string) {
    return t.herdctl.manager
      .getAgents()
      .find((a) => a.name === hookAgentName(slug, name)) as
      | { name: string; allowed_tools?: string[]; max_turns?: number; permission_mode?: string }
      | undefined;
  }

  it("lists an empty set + surfaces the picker catalog (tools + events)", async () => {
    const project = await freshProject();
    const r = await list(project.slug);
    expect(r.hooks).toEqual([]);
    // The capability picker's catalog is served with the list so the UI never
    // hard-codes the tool set. It must include the broad + tool-less anchors.
    expect(r.grantableTools.map((tl) => tl.name)).toEqual(
      expect.arrayContaining(["Read", "Write", "Bash"]),
    );
    expect(r.events).toContain("onArchive");
  });

  it("creates → persists YAML + arms the agent → edits → deletes a hook", async () => {
    const project = await freshProject();

    // Create: a cleanup hook granted Bash, disabled by default via the picker.
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/cleanup`,
      payload: {
        event: "onArchive",
        prompt: "spin down any pm servers this chat started",
        capabilities: { allowedTools: ["Bash", "Read"], permissionMode: "acceptEdits", maxTurns: 12 },
        enabled: false,
      },
    });
    expect(put.statusCode).toBe(200);
    const created = put.json().hook as HookDto;
    expect(created.name).toBe("cleanup");
    expect(created.agentName).toBe(hookAgentName(project.slug, "cleanup"));
    expect(created.enabled).toBe(false);

    // Persisted to project.yaml under the `hooks` map.
    const yaml = YAML.parse(
      await fs.readFile(path.join(t.projectsRoot, project.slug, "project.yaml"), "utf8"),
    ) as { hooks?: Record<string, Record<string, unknown>> };
    expect(yaml.hooks?.cleanup).toMatchObject({
      event: "onArchive",
      prompt: "spin down any pm servers this chat started",
      enabled: false,
      capabilities: { allowedTools: ["Bash", "Read"], permissionMode: "acceptEdits", maxTurns: 12 },
    });

    // The hook's OWN agent is armed, and its tool config IS the capability (GG-1):
    // allowed_tools == exactly the granted set, max_turns + permission_mode applied.
    const agent = armedAgent(project.slug, "cleanup");
    expect(agent).toBeDefined();
    expect(agent!.allowed_tools).toEqual(["Bash", "Read"]);
    expect(agent!.max_turns).toBe(12);
    expect(agent!.permission_mode).toBe("acceptEdits");

    // Listed back as a DTO.
    const listed = (await list(project.slug)).hooks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "cleanup",
      event: "onArchive",
      enabled: false,
      capabilities: { allowedTools: ["Bash", "Read"] },
    });

    // Edit: switch to a tool-less hook (no capabilities) → allowed_tools becomes [].
    const edit = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/cleanup`,
      payload: { event: "onArchive", prompt: "just think", enabled: false },
    });
    expect(edit.statusCode).toBe(200);
    expect(armedAgent(project.slug, "cleanup")!.allowed_tools).toEqual([]);

    // Delete: gone from the API AND from the fleet's agent set.
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.slug}/hooks/cleanup`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, name: "cleanup", removed: true });
    expect((await list(project.slug)).hooks).toEqual([]);
    expect(armedAgent(project.slug, "cleanup")).toBeUndefined();
  });

  it("enable/disable is a `set` with `enabled` flipped (no separate verb)", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/tick`,
      payload: { event: "onArchive", prompt: "x", enabled: false },
    });

    // Enable: re-PUT the record with enabled: true.
    const on = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/tick`,
      payload: { event: "onArchive", prompt: "x", enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().hook.enabled).toBe(true);
    expect((await list(project.slug)).hooks[0]!.enabled).toBe(true);

    // Disable again.
    const off = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/tick`,
      payload: { event: "onArchive", prompt: "x", enabled: false },
    });
    expect(off.json().hook.enabled).toBe(false);
  });

  it("GET one hook returns it; 404s an unknown name", async () => {
    const project = await freshProject();
    await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/one`,
      payload: { event: "onArchive", prompt: "hi", enabled: false },
    });
    const ok = await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/hooks/one` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().hook.name).toBe("one");
    const miss = await t.app.inject({
      method: "GET",
      url: `/api/projects/${project.slug}/hooks/nope`,
    });
    expect(miss.statusCode).toBe(404);
  });

  it("rejects a malformed hook (unknown event) and a bad name", async () => {
    const project = await freshProject();
    const badEvent = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/x`,
      payload: { event: "onNope", prompt: "y" },
    });
    expect(badEvent.statusCode).toBe(400);

    const badName = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${project.slug}/hooks/bad%20name`,
      payload: { event: "onArchive", prompt: "y" },
    });
    expect(badName.statusCode).toBe(400);
  });

  it("404s hooks on an unknown project", async () => {
    const r = await t.app.inject({ method: "GET", url: `/api/projects/does-not-exist/hooks` });
    expect(r.statusCode).toBe(404);
  });
});
