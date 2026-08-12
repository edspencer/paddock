/**
 * BackgroundRegistry unit coverage (#604) — the live background-work set fed
 * from the SDK's task-lifecycle system messages.
 *
 * The behaviours under test are the ones the design leans on: the level signal
 * is the sole authority on membership, edges may only enrich, and a missed
 * terminal edge cannot wedge a stale row.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BackgroundRegistry,
  roleForTaskType,
  type LiveBackgroundTask,
} from "../../src/background-live.js";

const SESSION = "sess-1";
const SLUG = "proj";

/**
 * `system/background_tasks_changed` — the level signal.
 *
 * `task_type` values here are the CLI's REAL internal discriminants. They used
 * to be the friendly names (`shell`, `subagent`, …) that nothing on the wire
 * ever sends, which is precisely why #846 went unnoticed: every assertion in
 * this file was made against a payload production could not produce.
 */
const level = (tasks: { id: string; type?: string; description?: string }[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  session_id: SESSION,
  tasks: tasks.map((t) => ({
    task_id: t.id,
    task_type: t.type ?? "local_bash",
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
    r.observe(SLUG, level([{ id: "a", type: "local_agent", description: "research" }]));
    r.observe(SLUG, started("a", { tool_use_id: "tu-1", subagent_type: "Explore" }));
    r.observe(SLUG, progress("a", { last_tool_name: "Grep", usage: { tool_uses: 7 } }));

    const [t] = r.list(SESSION);
    expect(t).toMatchObject({
      id: "a",
      type: "local_agent",
      role: "subagent",
      description: "research",
      toolUseId: "tu-1",
      agentType: "Explore",
      lastToolName: "Grep",
      toolUses: 7,
    });

    // A fresh level signal carries none of that detail; it must survive.
    r.observe(SLUG, level([{ id: "a", type: "local_agent", description: "research" }]));
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
    r.observe(SLUG, level([{ id: "a", type: "monitor_mcp", description: "watch log" }]));
    expect(onChange).toHaveBeenCalledWith(SLUG, SESSION, [
      expect.objectContaining({
        id: "a",
        type: "monitor_mcp",
        role: "monitor",
        description: "watch log",
      }),
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
    // Raw type preserved for diagnosis, and the role falls back to it rather
    // than being forced into a bucket we have no evidence for.
    expect(r.list(SESSION)[0]).toMatchObject({
      type: "some_future_kind",
      role: "some_future_kind",
    });
  });

  it("derives a role for every task type the CLI actually emits (#846)", () => {
    const r = new BackgroundRegistry();
    r.observe(
      SLUG,
      level([
        { id: "b", type: "local_bash" },
        { id: "a", type: "local_agent" },
        { id: "r", type: "remote_agent" },
        { id: "t", type: "in_process_teammate" },
        { id: "w", type: "local_workflow" },
        { id: "m", type: "monitor_mcp" },
        { id: "s", type: "monitor_ws" },
        { id: "k", type: "mcp_task" },
      ]),
    );
    expect(r.list(SESSION).map((t) => [t.type, t.role])).toEqual([
      ["local_bash", "shell"],
      ["local_agent", "subagent"],
      ["remote_agent", "subagent"],
      ["in_process_teammate", "subagent"],
      ["local_workflow", "workflow"],
      ["monitor_mcp", "monitor"],
      ["monitor_ws", "monitor"],
      ["mcp_task", "task"],
    ]);
  });
});

/**
 * The map itself. This is the whole of #846: the CLI's level payload is built by
 * `.map((t) => ({ task_id: t.id, task_type: t.type, ... }))` — the internal
 * discriminant verbatim — so none of the friendly names Paddock was written
 * against ever appears on the wire, and every row fell through to the raw string.
 */
describe("roleForTaskType (#846)", () => {
  it("maps the CLI's full id-prefix table", () => {
    expect(roleForTaskType("local_bash")).toBe("shell");
    expect(roleForTaskType("local_agent")).toBe("subagent");
    expect(roleForTaskType("remote_agent")).toBe("subagent");
    expect(roleForTaskType("in_process_teammate")).toBe("subagent");
    expect(roleForTaskType("local_workflow")).toBe("workflow");
    expect(roleForTaskType("monitor_mcp")).toBe("monitor");
    expect(roleForTaskType("monitor_ws")).toBe("monitor");
    expect(roleForTaskType("mcp_task")).toBe("task");
  });

  it("is identity for an unknown kind, so a new SDK type is still diagnosable", () => {
    expect(roleForTaskType("some_future_kind")).toBe("some_future_kind");
  });

  it("is identity for a friendly name, so an SDK that starts sending them just works", () => {
    for (const friendly of ["shell", "subagent", "monitor", "workflow", "task"])
      expect(roleForTaskType(friendly)).toBe(friendly);
  });
});

/**
 * Stoppability, resolved here because this is the last place the RAW SDK
 * discriminant is guaranteed to survive (#848). Downstream the type may be
 * collapsed to a friendly label, and `monitor_ws` and `monitor_mcp` both become
 * "monitor" — one killable, one not — so no client could work it out for itself.
 */
describe("BackgroundRegistry — stoppability (#848)", () => {
  it("marks an ordinary task stoppable", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "local_bash" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(true);
  });

  it("marks monitor_mcp UNSTOPPABLE — the CLI has no kill strategy for it", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "monitor_mcp" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(false);
  });

  it("keeps monitor_ws stoppable — only the MCP flavour is refused", () => {
    // The pair that makes this undecidable from a collapsed `monitor` label.
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "monitor_ws" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(true);
  });

  it("treats a task type it has never heard of as stoppable", () => {
    // A denylist, not an allowlist: an unknown new type gets a button, and a
    // refusal (if any) surfaces on the row. An allowlist would silently withhold
    // the button from every new stoppable type instead — the worse failure.
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "some_future_kind" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(true);
  });

  it("re-resolves stoppability when a level signal changes a task's type", () => {
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a", type: "local_bash" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(true);
    r.observe(SLUG, level([{ id: "a", type: "monitor_mcp" }]));
    expect(r.list(SESSION)[0].stoppable).toBe(false);
  });
});

/**
 * `dropTask` — the eviction for the one case the session's own stream can never
 * deliver (#848): `stopTaskInSession` answered `false`, meaning no live session,
 * so no `task_notification` is ever coming. Without it the row would sit at
 * `stopping…` forever describing work that is definitively gone.
 */
describe("BackgroundRegistry.dropTask (#848)", () => {
  it("removes the task and notifies, like a terminal edge would", () => {
    const r = new BackgroundRegistry();
    const seen: LiveBackgroundTask[][] = [];
    r.observe(SLUG, level([{ id: "a" }, { id: "b" }]));
    r.onChange = (_slug, _sid, tasks) => seen.push(tasks);
    expect(r.dropTask(SESSION, "a")).toBe(true);
    expect(r.list(SESSION).map((t) => t.id)).toEqual(["b"]);
    expect(seen).toHaveLength(1);
  });

  it("is quiet about a task or session it does not know", () => {
    // The click that raced a natural completion reaches here after the row has
    // already gone. Not an error, and it must not emit a redundant broadcast.
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }]));
    const onChange = vi.fn();
    r.onChange = onChange;
    expect(r.dropTask(SESSION, "nope")).toBe(false);
    expect(r.dropTask("no-such-session", "a")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is overruled by the next level signal, which stays the authority", () => {
    // The safety property that makes dropping on an out-of-band say-so sound: if
    // we were wrong and the task is alive, the level signal simply puts it back.
    const r = new BackgroundRegistry();
    r.observe(SLUG, level([{ id: "a" }]));
    r.dropTask(SESSION, "a");
    expect(r.list(SESSION)).toEqual([]);
    r.observe(SLUG, level([{ id: "a" }]));
    expect(r.list(SESSION).map((t) => t.id)).toEqual(["a"]);
  });
});
