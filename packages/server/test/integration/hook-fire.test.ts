/**
 * Event hooks, server side (Epic G / G1).
 *
 * Drives the WHOLE foundation against the REAL @herdctl/core FleetManager + CLI
 * runtime (fake `claude`, no Anthropic calls): a project declares an ENABLED
 * `onArchive` hook (its own `hook-<slug>-<name>` agent), a chat is archived, and the
 * archive-commit event routes through Paddock's in-process bus → dispatcher →
 * `startAgentTurn` on Paddock's OWN hub with `origin: hook`. The hook's granted tools
 * (its agent config) do the work; the fired turn is provenance-stamped + attributable.
 *
 * Assertions target the durable artifacts G1 owns (the run-provenance sidecar + the
 * hook agent's transcript), not the chat-list — surfacing hook chats in the list is a
 * later ticket (G3); here we prove the turn FIRED and RAN the hook's prompt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { hookAgentName } from "../../src/herdctl.js";
import type { Project } from "../../src/projects.js";

async function poll<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  { timeoutMs = 20_000, intervalMs = 150 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("integration: event hooks (Epic G / G1)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<Project> {
    const name = `Hooked ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { project: Project }).project;
  }

  /** The persisted run-provenance map (sessionId -> {origin, depth}); {} if absent. */
  async function provenance(): Promise<Record<string, { origin: string; depth: number }>> {
    const file = path.join(t.cfg.dataDir, "run-provenance.json");
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return {};
    }
  }
  async function hookChats(): Promise<[string, { origin: string; depth: number }][]> {
    return Object.entries(await provenance()).filter(([, p]) => p.origin === "hook");
  }

  /** Archive a chat via the REST route (the after-commit event source). */
  async function archive(slug: string, sessionId: string): Promise<void> {
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/archive`,
      payload: { archived: true },
    });
  }

  it("registers each declared hook as its own hook-<slug>-<name> agent", async () => {
    const project = await freshProject();
    await t.hooks.set(project.slug, "cleanup", {
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"], maxTurns: 5 },
      prompt: "clean up after the archive",
      enabled: true,
    });
    const agents = await t.herdctl.agents();
    const names = agents.map((a) => a.name);
    expect(names).toContain(hookAgentName(project.slug, "cleanup"));
  });

  it("fires an ENABLED onArchive hook after a chat-archive commits (origin hook, depth 0)", async () => {
    const project = await freshProject();
    const codeword = `onarchive-codeword-${project.slug}`;
    await t.hooks.set(project.slug, "cleanup", {
      event: "onArchive",
      // Tool-less hook: it just returns text — enough to prove the turn fired + ran
      // the hook's prompt without needing Bash side effects in the test sandbox.
      prompt: `HOOK RAN: ${codeword}`,
      enabled: true,
    });

    const before = (await hookChats()).length;
    await archive(project.slug, "victim-chat-1");

    // The hook turn produces a NEW chat stamped origin:hook, depth 0.
    const fired = await poll(
      () => hookChats(),
      (chats) => chats.length > before,
    );
    expect(fired.length).toBeGreaterThan(before);
    const [sid, prov] = fired[fired.length - 1]!;
    expect(prov).toEqual({ origin: "hook", depth: 0 });

    // The fired turn RAN the hook's prompt: the fake `claude` echoes the user prompt
    // into the transcript, and the hook agent shares the keeper's cwd so the keeper
    // agent resolves the same transcript. The event preamble + the codeword appear.
    const msgs = await t.herdctl.sessionMessages(hookAgentName(project.slug, "cleanup"), sid);
    const userText = msgs
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(userText).toContain(codeword);
    expect(userText).toContain("onArchive"); // the machine preamble names the event
    expect(userText).toContain("victim-chat-1"); // …and the archived chat's id
  });

  it("does NOT fire a DISABLED hook (enabled:false default is the safety guard)", async () => {
    const project = await freshProject();
    await t.hooks.set(project.slug, "cleanup", {
      event: "onArchive",
      prompt: "should never run",
      enabled: false,
    });

    const before = (await hookChats()).length;
    await archive(project.slug, "victim-chat-2");

    // Give the dispatcher ample time to (not) fire.
    await new Promise((r) => setTimeout(r, 2500));
    expect((await hookChats()).length).toBe(before);
  });

  it("does NOT fire on an UNARCHIVE (archived:false) — only the transition INTO archived", async () => {
    const project = await freshProject();
    await t.hooks.set(project.slug, "cleanup", {
      event: "onArchive",
      prompt: "only on archive",
      enabled: true,
    });

    const before = (await hookChats()).length;
    // Unarchive a chat that was never archived: a no-op transition — no event.
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/chats/never/archive`,
      payload: { archived: false },
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await hookChats()).length).toBe(before);
  });

  it("removing a hook tears down its agent and stops it firing", async () => {
    const project = await freshProject();
    await t.hooks.set(project.slug, "cleanup", {
      event: "onArchive",
      prompt: "temp hook",
      enabled: true,
    });
    const removed = await t.hooks.remove(project.slug, "cleanup");
    expect(removed).toBe(true);
    const agents = await t.herdctl.agents();
    expect(agents.map((a) => a.name)).not.toContain(hookAgentName(project.slug, "cleanup"));

    const before = (await hookChats()).length;
    await archive(project.slug, "victim-chat-3");
    await new Promise((r) => setTimeout(r, 2000));
    expect((await hookChats()).length).toBe(before);
  });
});
