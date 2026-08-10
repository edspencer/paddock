/**
 * BackgroundRegistry unit coverage (#604) — the live background-work set fed
 * from the SDK's task-lifecycle system messages.
 *
 * The behaviours under test are the ones the design leans on: the level signal
 * is the sole authority on membership, edges may only enrich, and a missed
 * terminal edge cannot wedge a stale row.
 */
import { describe, it, expect, vi } from "vitest";
import { BackgroundRegistry, type LiveBackgroundTask } from "../../src/background-live.js";

const SESSION = "sess-1";
const SLUG = "proj";

/** `system/background_tasks_changed` — the level signal. */
const level = (tasks: { id: string; type?: string; description?: string }[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  session_id: SESSION,
  tasks: tasks.map((t) => ({
    task_id: t.id,
    task_type: t.type ?? "shell",
    description: t.description ?? "",
  })),
});

const started = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  session_id: SESSION,
  task_id: id,
  ...extra,
});

const progress = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_progress",
  session_id: SESSION,
  task_id: id,
  ...extra,
});

const notify = (id: string) => ({
  type: "system",
  subtype: "task_notification",
  session_id: SESSION,
  task_id: id,
  status: "completed",
});

describe("BackgroundRegistry", () => {
  it("ignores everything that is not a task-lifecycle system message", () => {
    const r = new BackgroundRegistry();
    expect(r.observe(SLUG, { type: "assistant", session_id: SESSION })).toBe(false);
    expect(r.observe(SLUG, { type: "system", subtype: "init", session_id: SESSION })).toBe(false);
    expect(r.observe(SLUG, null)).toBe(false);
    expect(r.observe(SLUG, { type: "system", subtype: "background_tasks_changed" })).toBe(false);
    expect(r.isBusy(SESSION)).toBe(false);
  });

  it("REPLACES the set from the level signal, so a dropped task disappears", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }, { id: "b" }]));
    expect(r.list(SESSION).map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.isBusy(SESSION)).toBe(true);

    // 'a' finished; the level no longer lists it. No terminal edge was seen.
    r.observe(SLUG, level([{ id: "b" }]));
    expect(r.list(SESSION).map((t) => t.id)).toEqual(["b"]);

    r.observe(SLUG, level([]));
    expect(r.list(SESSION)).toEqual([]);
    expect(r.isBusy(SESSION)).toBe(false);
  });

  it("an edge NEVER creates a row — the level is the only authority on membership", () => {
    const r = new BackgroundRegistry();
    // A task_started with no preceding level must not conjure a task...
    expect(r.observe(SLUG, started("ghost", { description: "not real" }))).toBe(false);
    expect(r.list(SESSION)).toEqual([]);

    // ...and a late edge must not resurrect one the level has already dropped.
    r.observe(SLUG, level([{ id: "a" }]));
    r.observe(SLUG, level([]));
    expect(r.observe(SLUG, progress("a", { last_tool_name: "Bash" }))).toBe(false);
    expect(r.list(SESSION)).toEqual([]);
  });

  it("folds edge detail onto the level row and preserves it across the next level", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "subagent", description: "research" }]));
    r.observe(SLUG, started("a", { tool_use_id: "tu-1", subagent_type: "Explore" }));
    r.observe(SLUG, progress("a", { last_tool_name: "Grep", usage: { tool_uses: 7 } }));

    const [t] = r.list(SESSION);
    expect(t).toMatchObject({
      id: "a",
      type: "subagent",
      description: "research",
      toolUseId: "tu-1",
      agentType: "Explore",
      lastToolName: "Grep",
      toolUses: 7,
    });

    // A fresh level signal carries none of that detail; it must survive.
    r.observe(SLUG, level([{ id: "a", type: "subagent", description: "research" }]));
    expect(r.list(SESSION)[0]).toMatchObject({ toolUseId: "tu-1", lastToolName: "Grep", toolUses: 7 });
  });

  it("evicts on a terminal edge without waiting for the next level", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }, { id: "b" }]));
    expect(r.observe(SLUG, notify("a"))).toBe(true);
    expect(r.list(SESSION).map((t) => t.id)).toEqual(["b"]);
  });

  it("treats a terminal task_updated patch as an eviction and a live one as enrichment", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }]));

    r.observe(SLUG, {
      type: "system",
      subtype: "task_updated",
      session_id: SESSION,
      task_id: "a",
      patch: { description: "still going" },
    });
    expect(r.list(SESSION)[0].description).toBe("still going");

    r.observe(SLUG, {
      type: "system",
      subtype: "task_updated",
      session_id: SESSION,
      task_id: "a",
      patch: { status: "killed" },
    });
    expect(r.list(SESSION)).toEqual([]);
  });

  it("stamps startedAt once and does not restamp on later level signals", () => {
    let t = 1000;
    const r = new BackgroundRegistry(() => t);
    r.observe(SLUG, level([{ id: "a" }]));
    expect(r.list(SESSION)[0].startedAt).toBe(1000);
    t = 5000;
    r.observe(SLUG, level([{ id: "a" }, { id: "b" }]));
    const byId = new Map(r.list(SESSION).map((x) => [x.id, x]));
    expect(byId.get("a")!.startedAt).toBe(1000);
    expect(byId.get("b")!.startedAt).toBe(5000);
  });

  it("stays quiet when a level signal changes nothing", () => {
    const seen: LiveBackgroundTask[][] = [];
    const r = new BackgroundRegistry();
    r.onChange = (_slug, _sid, tasks) => seen.push(tasks);
    expect(r.observe(SLUG, level([{ id: "a" }]))).toBe(true);
    expect(r.observe(SLUG, level([{ id: "a" }]))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("notifies with the project slug and session id so the WS layer can route", () => {
    const r = new BackgroundRegistry();
    const onChange = vi.fn();
    r.onChange = onChange;
    r.observe(SLUG, level([{ id: "a", type: "monitor", description: "watch log" }]));
    expect(onChange).toHaveBeenCalledWith(SLUG, SESSION, [
      expect.objectContaining({ id: "a", type: "monitor", description: "watch log" }),
    ]);
  });

  it("clear() resets a session, as the per-process level contract requires", () => {
    const r = new BackgroundRegistry();
    const onChange = vi.fn();
    r.observe(SLUG, level([{ id: "a" }]));
    r.onChange = onChange;
    r.clear(SESSION);
    expect(r.isBusy(SESSION)).toBe(false);
    expect(onChange).toHaveBeenCalledWith(SLUG, SESSION, []);
    // Idempotent: a second clear is silent.
    onChange.mockClear();
    r.clear(SESSION);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("snapshot() returns only sessions with live work, for the connect-time replay", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }]));
    r.observe("other", {
      type: "system",
      subtype: "background_tasks_changed",
      session_id: "sess-2",
      tasks: [],
    });
    expect(r.snapshot()).toEqual([
      { projectSlug: SLUG, sessionId: SESSION, tasks: [expect.objectContaining({ id: "a" })] },
    ]);
  });

  it("keeps an unknown task type rather than dropping the row", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "some_future_kind", description: "?" }]));
    expect(r.list(SESSION)[0].type).toBe("some_future_kind");
  });
});
