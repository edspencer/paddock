/**
 * Unified triggers, server side (Epic T "Unify Triggers" / T1 — foundation).
 *
 * Drives the WHOLE foundation against the REAL @herdctl/core FleetManager + scheduler +
 * CLI runtime (fake `claude`, no Anthropic calls), proving the ticket's acceptance:
 *
 *  1. an EVENT-type trigger fires a real turn through `startAgentTurn` — on its own
 *     `trigger-<slug>-<name>` agent, `origin: hook`, after a chat-archive commits;
 *  2. a SCHEDULE-type trigger fires a real turn through `startAgentTurn` — armed on the
 *     keeper's forwarded `schedules` block, `origin: scheduled`, via herdctl's cron
 *     engine → `setScheduleTriggerHandler`;
 *  3. a DISABLED trigger never fires (the `enabled: false` safe default is the guard);
 *  4. a `run.session: "resume"` trigger owns ONE session, recorded in the sidecar and
 *     REBOUND off the reloaded file after a restart (a fresh TriggerSessionStore) — and
 *     a forced second fire resumes that same owned chat.
 *
 * Both fire paths (event bus + schedule handler) converge on the ONE trigger fire
 * function — the unification T1 delivers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { triggerAgentName } from "../../src/herdctl.js";
import { TriggerSessionStore } from "../../src/trigger-session.js";
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

type DtoChat = { sessionId: string; running?: boolean; provenance?: { origin: string; depth: number } };

describe("integration: unified triggers (Epic T / T1)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<Project> {
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: `Trig ${++n}` } });
    return (res.json() as { project: Project }).project;
  }

  /** The persisted run-provenance map (sessionId -> {origin, depth}); {} if absent. */
  async function provenance(): Promise<Record<string, { origin: string; depth: number }>> {
    try {
      return JSON.parse(await fs.readFile(path.join(t.cfg.dataDir, "run-provenance.json"), "utf8"));
    } catch {
      return {};
    }
  }
  async function chatsWithOrigin(origin: string): Promise<[string, { origin: string; depth: number }][]> {
    return Object.entries(await provenance()).filter(([, p]) => p.origin === origin);
  }

  async function scheduledChats(slug: string): Promise<DtoChat[]> {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })).json()
      .chats as DtoChat[];
    return chats.filter((c) => c.provenance?.origin === "scheduled");
  }

  async function ownedSession(slug: string, name: string): Promise<string | undefined> {
    try {
      return (JSON.parse(await fs.readFile(path.join(t.cfg.dataDir, "trigger-sessions.json"), "utf8")) as Record<string, string>)[
        `${slug}\0${name}`
      ];
    } catch {
      return undefined;
    }
  }

  async function archive(slug: string, sessionId: string): Promise<void> {
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/archive`,
      payload: { archived: true },
    });
  }

  it("fires an ENABLED event trigger on archive (its own agent, origin hook, depth 0)", async () => {
    const project = await freshProject();
    const codeword = `event-trigger-${project.slug}`;
    await t.triggers.set(project.slug, "cleanup", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: `TRIGGER RAN: ${codeword}` },
      enabled: true,
    });
    // The agent is registered under the unified trigger prefix.
    const names = (await t.herdctl.agents()).map((a) => a.name);
    expect(names).toContain(triggerAgentName(project.slug, "cleanup"));

    const before = (await chatsWithOrigin("hook")).length;
    await archive(project.slug, "victim-1");

    const fired = await poll(() => chatsWithOrigin("hook"), (c) => c.length > before);
    expect(fired.length).toBeGreaterThan(before);
    const [sid, prov] = fired[fired.length - 1]!;
    expect(prov).toEqual({ origin: "hook", depth: 0 });

    // The fired turn RAN the trigger's prompt: the fake `claude` echoes the user prompt
    // into the transcript; the event preamble + codeword appear.
    const msgs = await t.herdctl.sessionMessages(triggerAgentName(project.slug, "cleanup"), sid);
    const userText = msgs
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(userText).toContain(codeword);
    expect(userText).toContain("onArchive"); // machine preamble names the event
    expect(userText).toContain("victim-1"); // …and the archived chat's id
  });

  it("fires an ENABLED schedule trigger via herdctl's cron engine (origin scheduled, depth 0)", async () => {
    const project = await freshProject();
    // An interval "1h" with no prior run is due immediately, so it fires exactly once.
    await t.triggers.set(project.slug, "tick", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "run the scheduled trigger" },
      enabled: true,
    });

    const found = await poll(() => scheduledChats(project.slug), (c) => c.length >= 1);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]!.provenance).toEqual({ origin: "scheduled", depth: 0 });
    // Durable in the provenance sidecar too.
    const prov = await provenance();
    expect(prov[found[0]!.sessionId]).toEqual({ origin: "scheduled", depth: 0 });

    // Stop further fires interfering with later assertions.
    await t.triggers.remove(project.slug, "tick");
  });

  it("does NOT fire a DISABLED trigger (event or schedule)", async () => {
    const project = await freshProject();
    await t.triggers.set(project.slug, "off-event", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "never" },
      enabled: false,
    });
    await t.triggers.set(project.slug, "off-sched", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "never" },
      enabled: false,
    });

    const beforeHook = (await chatsWithOrigin("hook")).length;
    await archive(project.slug, "victim-off");
    await new Promise((r) => setTimeout(r, 2500));
    // No new hook-origin chat from the disabled event trigger…
    expect((await chatsWithOrigin("hook")).length).toBe(beforeHook);
    // …and the disabled schedule trigger produced no scheduled chat.
    expect(await scheduledChats(project.slug)).toHaveLength(0);
  });

  it("session:resume owns ONE session, rebinds after a restart, and a 2nd fire reuses it", async () => {
    const project = await freshProject();
    const arm = () =>
      t.triggers.set(project.slug, "mgr", {
        trigger: { type: "schedule", interval: "1h" },
        run: { prompt: "accrete into one transcript", session: "resume" },
        enabled: true,
      });
    await arm();

    // First fire records the owned session id (== the one scheduled chat).
    const firstOwned = await poll(() => ownedSession(project.slug, "mgr"), (v) => typeof v === "string");
    expect(typeof firstOwned).toBe("string");
    const oneChat = await poll(() => scheduledChats(project.slug), (c) => c.length >= 1);
    expect(oneChat.map((c) => c.sessionId)).toContain(firstOwned);

    // REBIND AFTER RESTART: a fresh TriggerSessionStore reading the same data dir (a
    // server restart) rebinds the same owned id off the reloaded sidecar.
    const reloaded = new TriggerSessionStore(t.cfg.dataDir);
    expect(await reloaded.get(project.slug, "mgr")).toBe(firstOwned);

    // Let the first turn settle before forcing a second fire.
    await poll(
      () => t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/chats` }).then((r) => r.json().chats as DtoChat[]),
      (chats) => chats.some((c) => c.sessionId === firstOwned && !c.running),
    );

    // Force a controlled second fire (remove+re-add makes the interval due again). It
    // must RESUME the owned session, not create a new one.
    await t.triggers.remove(project.slug, "mgr");
    await arm();
    await new Promise((r) => setTimeout(r, 4000));
    const afterSecond = await scheduledChats(project.slug);
    await t.triggers.remove(project.slug, "mgr");
    expect(afterSecond.map((c) => c.sessionId)).toEqual([firstOwned]);
    expect(await ownedSession(project.slug, "mgr")).toBe(firstOwned);
  });
});
