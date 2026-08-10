/**
 * Live background-work registry (#604).
 *
 * Paddock's only notion of "this chat is busy" is `SessionHub`'s single `Turn`
 * per session. That is wrong for background work in two directions: a turn ends
 * while its background tasks keep running (this issue), and a background task
 * outlives the `Turn` record entirely, so the task set cannot live on it.
 *
 * The Claude Agent SDK already publishes the set we need. This module is the
 * server-side landing point for it:
 *
 *   - `system/background_tasks_changed` — a LEVEL signal carrying every live
 *     task after a membership change. Consumed with REPLACE semantics, per the
 *     SDK's own guidance: "consumers that only need 'is background work
 *     running' should replace their set with each payload rather than pairing
 *     edges, so a missed bookend cannot wedge a stale running indicator."
 *     #528 was exactly such a wedge, so this is load-bearing, not stylistic.
 *
 *   - `system/task_started` / `system/task_progress` — EDGE signals carrying the
 *     detail the level payload omits (`tool_use_id`, `subagent_type`,
 *     `workflow_name`, `last_tool_name`, step counts). Folded onto the level set
 *     as enrichment only: an edge NEVER adds a task the level has not shown us,
 *     because the edges are not guaranteed to pair and a leaked edge would
 *     resurrect a finished task.
 *
 *   - `system/task_notification` / `system/task_updated` — terminal edges. These
 *     evict eagerly rather than waiting for the next level, so a completed task
 *     leaves the bar promptly; a level signal that still lists it will simply
 *     put it back.
 *
 * Per-process caveat, straight from the SDK: the level is "per-process: nothing
 * is emitted at startup, so consumers must reset to the empty set whenever the
 * session's CLI process (re)starts". {@link BackgroundRegistry.clear} is that
 * reset. Nothing here tries to reconstruct a set from disk — an empty bar after
 * a restart is correct, because Paddock stops the fleet with
 * `waitForJobs: false` and the tasks are genuinely dead.
 */

/** Terminal task statuses — a task in one of these is no longer live. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);

/**
 * One live background task, as broadcast to clients.
 *
 * `type` is the SDK's friendly label (`shell` | `subagent` | `monitor` |
 * `workflow`), falling back to the raw discriminant for kinds we do not know
 * about yet — deliberately a plain `string` rather than a union so a new SDK
 * task type renders as an unlabelled row instead of being dropped.
 */
export interface LiveBackgroundTask {
  id: string;
  type: string;
  description: string;
  /** Epoch-ms this task was first observed. Stamped here; the SDK sends no start time. */
  startedAt: number;
  /** Links the task to its launching tool card, when an edge has told us. */
  toolUseId?: string;
  /** `subagent` only. */
  agentType?: string;
  /** `shell` only. */
  command?: string;
  /** `workflow` only. */
  workflowName?: string;
  /** `monitor` / MCP-task only. */
  server?: string;
  tool?: string;
  /** Latest tool the task ran, from `task_progress`. */
  lastToolName?: string;
  /** Steps the task has taken, from `task_progress.usage.tool_uses`. */
  toolUses?: number;
  /**
   * Ambient/housekeeping work. The SDK asks consumers to hide these from the
   * inline transcript while still allowing a tasks panel to show them, so it is
   * carried on the wire and filtered at the point of display.
   */
  skipTranscript?: boolean;
}

/** A session's task set plus the project it belongs to (needed to route frames). */
interface SessionEntry {
  projectSlug: string;
  tasks: Map<string, LiveBackgroundTask>;
}

/** Shape of the SDK's `background_tasks_changed` payload entries. */
interface RawLevelTask {
  task_id?: unknown;
  task_type?: unknown;
  description?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Is this an SDK system message we care about? Structural rather than a typed
 * narrow, because the SDK's `SDKMessage` union gains subtypes faster than we
 * pin its version, and an unknown subtype must be ignored, not crash the turn.
 */
function systemSubtype(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (o.type !== "system") return null;
  return typeof o.subtype === "string" ? o.subtype : null;
}

export type BackgroundChangeListener = (
  projectSlug: string,
  sessionId: string,
  tasks: LiveBackgroundTask[],
) => void;

/**
 * The registry. One instance per server, owned by the WS layer so it can
 * broadcast, and fed by the turn engine from both the foreground and background
 * message lanes.
 */
export class BackgroundRegistry {
  private bySession = new Map<string, SessionEntry>();
  /** Fired whenever a session's live set changes. Set by the WS layer. */
  onChange: BackgroundChangeListener | null = null;
  /** Injectable clock, so tests can assert `startedAt` without sleeping. */
  constructor(private now: () => number = Date.now) {}

  /** Live tasks for a session, newest last. Empty array when idle or unknown. */
  list(sessionId: string): LiveBackgroundTask[] {
    const e = this.bySession.get(sessionId);
    return e ? [...e.tasks.values()] : [];
  }

  /** Every session with at least one live task — the connect-time snapshot. */
  snapshot(): { projectSlug: string; sessionId: string; tasks: LiveBackgroundTask[] }[] {
    const out: { projectSlug: string; sessionId: string; tasks: LiveBackgroundTask[] }[] = [];
    for (const [sessionId, e] of this.bySession) {
      if (e.tasks.size > 0)
        out.push({ projectSlug: e.projectSlug, sessionId, tasks: [...e.tasks.values()] });
    }
    return out;
  }

  /** Does this session have live background work? The #604 predicate. */
  isBusy(sessionId: string): boolean {
    const e = this.bySession.get(sessionId);
    return !!e && e.tasks.size > 0;
  }

  /**
   * Forget a session's set. Called when the session's process restarts or its
   * stream ends — see the per-process caveat in the module header.
   */
  clear(sessionId: string): void {
    const e = this.bySession.get(sessionId);
    if (!e || e.tasks.size === 0) return;
    e.tasks.clear();
    this.emit(sessionId, e);
  }

  /**
   * Feed one raw SDK message. Returns true when the live set changed, so the
   * caller can avoid re-broadcasting on the overwhelming majority of messages
   * (assistant text, tool calls) that are not task lifecycle at all.
   */
  observe(projectSlug: string, m: unknown): boolean {
    const subtype = systemSubtype(m);
    if (!subtype) return false;
    const o = m as Record<string, unknown>;
    const sessionId = str(o.session_id);
    if (!sessionId) return false;

    switch (subtype) {
      case "background_tasks_changed":
        return this.replace(projectSlug, sessionId, Array.isArray(o.tasks) ? o.tasks : []);
      case "task_started":
        return this.enrich(sessionId, str(o.task_id), {
          toolUseId: str(o.tool_use_id),
          agentType: str(o.subagent_type),
          workflowName: str(o.workflow_name),
          description: str(o.description),
          skipTranscript: o.skip_transcript === true ? true : undefined,
        });
      case "task_progress": {
        const usage = (o.usage ?? {}) as Record<string, unknown>;
        return this.enrich(sessionId, str(o.task_id), {
          toolUseId: str(o.tool_use_id),
          agentType: str(o.subagent_type),
          lastToolName: str(o.last_tool_name),
          toolUses: num(usage.tool_uses),
        });
      }
      case "task_notification":
        // Always terminal — the SDK only emits this on completed/failed/stopped.
        return this.evict(sessionId, str(o.task_id));
      case "task_updated": {
        const patch = (o.patch ?? {}) as Record<string, unknown>;
        const status = str(patch.status);
        if (status && TERMINAL_STATUSES.has(status)) return this.evict(sessionId, str(o.task_id));
        // A non-terminal patch (e.g. paused) is still enrichment.
        return this.enrich(sessionId, str(o.task_id), { description: str(patch.description) });
      }
      default:
        return false;
    }
  }

  /**
   * REPLACE the session's set from a level signal, preserving the enrichment we
   * have already folded onto tasks that survive. Without the merge, every level
   * signal would blank the `tool_use_id` and step counts that only the edges
   * carry, making rows flicker between detailed and bare.
   */
  private replace(projectSlug: string, sessionId: string, raw: unknown[]): boolean {
    const prev = this.bySession.get(sessionId);
    const next = new Map<string, LiveBackgroundTask>();
    for (const t of raw) {
      const rt = (t ?? {}) as RawLevelTask;
      const id = str(rt.task_id);
      if (!id) continue;
      const existing = prev?.tasks.get(id);
      next.set(id, {
        ...existing,
        id,
        type: str(rt.task_type) ?? existing?.type ?? "task",
        description: str(rt.description) ?? existing?.description ?? "",
        startedAt: existing?.startedAt ?? this.now(),
      });
    }
    if (prev && sameSet(prev.tasks, next)) {
      // Membership and detail unchanged — keep the projectSlug fresh but stay quiet.
      prev.projectSlug = projectSlug;
      return false;
    }
    const entry: SessionEntry = { projectSlug, tasks: next };
    this.bySession.set(sessionId, entry);
    this.emit(sessionId, entry);
    return true;
  }

  /**
   * Fold edge detail onto an EXISTING task. Deliberately a no-op for an unknown
   * id: the level signal is the sole authority on membership, so an edge can
   * never create a row (and a late edge can never resurrect a finished one).
   */
  private enrich(sessionId: string, taskId: string | undefined, patch: Partial<LiveBackgroundTask>): boolean {
    if (!taskId) return false;
    const e = this.bySession.get(sessionId);
    const cur = e?.tasks.get(taskId);
    if (!e || !cur) return false;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<LiveBackgroundTask>;
    const keys = Object.keys(defined) as (keyof LiveBackgroundTask)[];
    if (keys.length === 0 || keys.every((k) => cur[k] === defined[k])) return false;
    e.tasks.set(taskId, { ...cur, ...defined });
    this.emit(sessionId, e);
    return true;
  }

  /** Drop a task on a terminal edge, ahead of the level that will confirm it. */
  private evict(sessionId: string, taskId: string | undefined): boolean {
    if (!taskId) return false;
    const e = this.bySession.get(sessionId);
    if (!e || !e.tasks.delete(taskId)) return false;
    this.emit(sessionId, e);
    return true;
  }

  private emit(sessionId: string, e: SessionEntry): void {
    this.onChange?.(e.projectSlug, sessionId, [...e.tasks.values()]);
  }
}

/** Do two task maps carry the same ids AND the same rendered detail? */
function sameSet(
  a: Map<string, LiveBackgroundTask>,
  b: Map<string, LiveBackgroundTask>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ta] of a) {
    const tb = b.get(id);
    if (!tb) return false;
    if (ta.type !== tb.type || ta.description !== tb.description) return false;
  }
  return true;
}
