import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { relativeTime, untilTime } from "../lib/format";
import type {
  GrantableTool,
  Project,
  Trigger,
  TriggerEvent,
  TriggerInput,
  TriggerPermissionMode,
  TriggerRuntime,
  TriggerType,
  TriggerWhen,
} from "../lib/types";
import {
  AlertIcon,
  BoltIcon,
  ClockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "./icons";

/** A valid trigger name / herdctl key segment (mirrors the server's `isValidTriggerName`). */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Human labels for each lifecycle event an event-trigger can fire on. */
const EVENT_LABELS: Record<TriggerEvent, string> = {
  onArchive: "On archive — a chat is archived",
  afterTurn: "After turn — a user turn completes",
};

/** Human labels + descriptions for each trigger type in the type picker. */
const TYPE_LABELS: Record<TriggerType, string> = {
  schedule: "Schedule — a cron / interval fires it",
  event: "Event — a lifecycle event fires it",
  webhook: "Webhook — an inbound HTTP call fires it",
};

/** Permission modes offered in the picker (mirrors the server's PERMISSION_MODES). */
const PERMISSION_MODES: { value: "" | TriggerPermissionMode; label: string }[] = [
  { value: "", label: "Default (fleet default)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only" },
  { value: "default", label: "Ask each time" },
  { value: "bypassPermissions", label: "Bypass all (use with care)" },
];

/** Labels + order for the grantable-tool groups in the picker. */
const GROUP_LABELS: Record<GrantableTool["group"], string> = {
  read: "Read",
  write: "Write & execute",
  web: "Web",
  orchestration: "Orchestration",
  browser: "Browser",
};
const GROUP_ORDER: GrantableTool["group"][] = ["read", "write", "web", "orchestration", "browser"];

/** The editor's flattened working copy of a trigger. */
interface Draft {
  name: string;
  /** WHEN discriminant. */
  type: TriggerType;
  /** For a schedule: cron vs interval, and its expression. */
  scheduleKind: "cron" | "interval";
  expr: string;
  /** For an event: the lifecycle event it fires on. */
  event: TriggerEvent;
  /** For a webhook (reserved): the ingress path. */
  path: string;
  /** The run definition. */
  promptMode: "inline" | "file";
  prompt: string;
  promptFile: string;
  /** `false` = a fresh chat each fire; `true` = one owned accreting session. */
  resumeSession: boolean;
  /** Selected `run.tools` allow-list (the capability). */
  allowedTools: Set<string>;
  /** "" = don't set (fleet default). */
  permissionMode: "" | TriggerPermissionMode;
  /** "" = keeper default model. */
  model: string;
  /** "" = server default (30). */
  maxTurns: string;
  /** "" = inherit; a non-negative integer bounds internal spawning (0 = may not spawn). */
  maxSpawnDepth: string;
  enabled: boolean;
}

function blankDraft(type: TriggerType, event: TriggerEvent): Draft {
  return {
    name: "",
    type,
    scheduleKind: "interval",
    expr: "",
    event,
    path: "",
    promptMode: "inline",
    prompt: "",
    promptFile: "",
    resumeSession: false,
    allowedTools: new Set(),
    permissionMode: "",
    model: "",
    maxTurns: "",
    maxSpawnDepth: "",
    // New triggers are DISABLED by default (design §2.3) — nothing fires the instant one is saved.
    enabled: false,
  };
}

/** Prefill the editor from an existing trigger (its name is then read-only). */
function draftFrom(t: Trigger): Draft {
  const w = t.trigger;
  const run = t.run;
  return {
    name: t.name,
    type: w.type,
    scheduleKind: w.type === "schedule" && w.interval !== undefined ? "interval" : "cron",
    expr:
      w.type === "schedule"
        ? w.cron !== undefined
          ? w.cron
          : (w.interval ?? "")
        : "",
    event: w.type === "event" ? w.on : "onArchive",
    path: w.type === "webhook" ? w.path : "",
    promptMode: run.promptFile ? "file" : "inline",
    prompt: run.prompt ?? "",
    promptFile: run.promptFile ?? "",
    resumeSession: run.session === "resume",
    allowedTools: new Set(run.tools ?? []),
    permissionMode: run.permissionMode ?? "",
    model: run.model ?? "",
    maxTurns: run.maxTurns != null ? String(run.maxTurns) : "",
    maxSpawnDepth: run.maxSpawnDepth != null ? String(run.maxSpawnDepth) : "",
    enabled: t.enabled === true,
  };
}

/** Project a {@link Draft} onto the server's write shape (`{ trigger, run, enabled }`). */
function toInput(d: Draft): TriggerInput {
  let when: TriggerWhen;
  if (d.type === "event") when = { type: "event", on: d.event };
  else if (d.type === "webhook") when = { type: "webhook", path: d.path.trim() };
  else
    when =
      d.scheduleKind === "cron"
        ? { type: "schedule", cron: d.expr.trim() }
        : { type: "schedule", interval: d.expr.trim() };

  const run: TriggerInput["run"] = {
    session: d.resumeSession ? "resume" : "new",
    tools: [...d.allowedTools],
  };
  if (d.promptMode === "file") run.promptFile = d.promptFile.trim();
  else run.prompt = d.prompt;
  if (d.permissionMode) run.permissionMode = d.permissionMode;
  if (d.model.trim()) run.model = d.model.trim();
  const turns = Number(d.maxTurns);
  if (d.maxTurns.trim() && Number.isFinite(turns) && turns > 0) run.maxTurns = Math.floor(turns);
  const depth = Number(d.maxSpawnDepth);
  if (d.maxSpawnDepth.trim() && Number.isFinite(depth) && depth >= 0)
    run.maxSpawnDepth = Math.floor(depth);

  return { trigger: when, run, enabled: d.enabled };
}

/** A compact one-line summary of a trigger's granted tools, for the list. */
function capabilitySummary(t: Trigger): string {
  const tools = t.run.tools ?? [];
  // A tool-less SCHEDULE runs as the keeper (full tools); a tool-less EVENT is a
  // deliberately tool-less curator (design §2.3 — the one asymmetry).
  if (tools.length === 0) return t.trigger.type === "schedule" ? "Keeper tools" : "Tool-less";
  return `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
}

/** The firing-condition cell: an event name, a cron/interval expression, or a webhook path. */
function whenSummary(w: TriggerWhen): string {
  if (w.type === "event") return w.on;
  if (w.type === "webhook") return w.path;
  return w.cron ?? w.interval ?? "";
}

/**
 * The per-project Triggers tab (Epic T "Unify Triggers" / T4). ONE list that
 * subsumes the former Hooks tab (event hooks) and the Settings→Schedules section
 * (cron/interval schedules) — a trigger is WHEN (`trigger`, a discriminated union of
 * schedule|event|webhook) + WHAT (`run`, a shared agent-run definition) + `enabled`,
 * managed over the unified `/api/projects/:slug/triggers` REST surface (T3).
 *
 * Each row shows a trigger-type badge, its firing condition, a capability summary, and
 * an enabled toggle. Enable/disable is NOT a separate verb — it's a `set` (PUT) with
 * the `enabled` field flipped (GG-3); new triggers are created DISABLED so nothing
 * fires the instant one is written. The webhook type is shown but reserved (its ingress
 * is the deferred T6) — you can see the shape but not create one. All mutations run
 * through their own endpoints (immediate), so the pane manages its own state.
 */
export function TriggersPane({ project }: { project: Project }) {
  const slug = project.slug;
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [grantableTools, setGrantableTools] = useState<GrantableTool[]>([]);
  const [events, setEvents] = useState<TriggerEvent[]>(["onArchive", "afterTurn"]);
  const [types, setTypes] = useState<TriggerType[]>(["schedule", "event", "webhook"]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ isNew: boolean; draft: Draft } | null>(null);
  // The trigger name a per-row action is in flight for (disables that row's buttons).
  const [busy, setBusy] = useState<string | null>(null);
  // Live runtime state (last-run / next-run / running), keyed by trigger name (#327).
  // Polled independently of the config list so status refreshes without re-fetching the
  // picker catalog. Best-effort — a runtime fetch failure never blocks the config view.
  const [runtime, setRuntime] = useState<Record<string, TriggerRuntime>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listTriggers(slug);
      setTriggers(r.triggers);
      setGrantableTools(r.grantableTools);
      if (r.events.length > 0) setEvents(r.events);
      if (r.triggerTypes.length > 0) setTypes(r.triggerTypes);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load triggers");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const loadRuntime = useCallback(async () => {
    try {
      const r = await api.triggerRuntime(slug);
      setRuntime(Object.fromEntries(r.runtime.map((rt) => [rt.name, rt])));
    } catch {
      // Best-effort: keep the last-known runtime rather than clearing the columns.
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll runtime state while the tab is mounted (last/next-run + running-state drift
  // out of band with config). Refetch immediately on project change, then every 10s;
  // skip the tick while a tab is hidden so a backgrounded tab does no work.
  useEffect(() => {
    void loadRuntime();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadRuntime();
    }, 10_000);
    return () => clearInterval(id);
  }, [loadRuntime]);

  // Clear the transient "saved / deleted" notice a moment after it appears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const draft = editing?.draft;
  const nameTaken = useMemo(
    () => (editing?.isNew ? triggers.some((t) => t.name === draft?.name.trim()) : false),
    [editing, draft, triggers],
  );
  const nameInvalid = !!draft && (!NAME_RE.test(draft.name.trim()) || draft.name.trim().length > 64);
  // WHEN validity depends on the chosen type.
  const whenInvalid =
    !!draft &&
    (draft.type === "schedule"
      ? draft.expr.trim().length === 0
      : draft.type === "webhook"
        ? draft.path.trim().length === 0
        : false);
  const promptInvalid =
    !!draft &&
    (draft.promptMode === "file"
      ? draft.promptFile.trim().length === 0 || !draft.promptFile.trim().toLowerCase().endsWith(".md")
      : draft.prompt.trim().length === 0);
  // The webhook ingress is reserved (deferred T6) — the shape is shown but not creatable.
  const webhookReserved = !!draft && draft.type === "webhook";
  const formInvalid = nameInvalid || nameTaken || whenInvalid || promptInvalid || webhookReserved;

  const patchDraft = (p: Partial<Draft>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));

  const toggleTool = (tool: string) =>
    setEditing((e) => {
      if (!e) return e;
      const next = new Set(e.draft.allowedTools);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return { ...e, draft: { ...e.draft, allowedTools: next } };
    });

  const saveDraft = async () => {
    if (!editing || formInvalid) return;
    const name = editing.draft.name.trim();
    setBusy(name);
    try {
      await api.putTrigger(slug, name, toInput(editing.draft));
      setEditing(null);
      setNotice(`Saved “${name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save trigger");
    } finally {
      setBusy(null);
    }
  };

  // Enable/disable is just a `set` with `enabled` flipped (GG-3) — no separate verb.
  // A full replace of the record with the flag flipped (T3's PUT is a full replace).
  const toggle = async (t: Trigger) => {
    setBusy(t.name);
    try {
      const updated = await api.putTrigger(slug, t.name, {
        trigger: t.trigger,
        run: t.run,
        enabled: !t.enabled,
      });
      setTriggers((prev) => prev.map((x) => (x.name === t.name ? updated : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update trigger");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: Trigger) => {
    if (!window.confirm(`Delete trigger “${t.name}”? This can’t be undone.`)) return;
    setBusy(t.name);
    try {
      await api.deleteTrigger(slug, t.name);
      setTriggers((prev) => prev.filter((x) => x.name !== t.name));
      setNotice(`Deleted “${t.name}”.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete trigger");
    } finally {
      setBusy(null);
    }
  };

  // Fire a trigger NOW (#327). Runs it through the same hub path a cron / event fire
  // uses, so the resulting chat is a first-class, badged run. Works regardless of the
  // trigger's enabled flag (a manual run is deliberate). Refreshes runtime so the row's
  // last-run / running state reflects the fire straight away.
  const runNow = async (t: Trigger) => {
    setBusy(t.name);
    try {
      await api.runTrigger(slug, t.name);
      setNotice(`Ran “${t.name}” — a new chat is starting.`);
      await loadRuntime();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to run trigger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="triggers-pane">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <section className="mb-6">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            <BoltIcon width={14} height={14} />
            Triggers
          </h3>
          <p className="mb-3 mt-0.5 text-[13px] text-paddock-500">
            A trigger runs an agent turn when something happens — a{" "}
            <span className="font-medium">schedule</span> (a cron/interval fires), an{" "}
            <span className="font-medium">event</span> (a lifecycle event like a chat being
            archived), or a <span className="font-medium">webhook</span> (reserved). Each trigger's
            granted tools <em>are</em> its capability. New triggers are created disabled; enable one
            when you’re ready for it to fire.
          </p>
          <div className="card">
            {error && (
              <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </p>
            )}
            {notice && (
              <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                {notice}
              </p>
            )}

            {loading ? (
              <p className="py-4 text-center text-sm text-paddock-400">Loading triggers…</p>
            ) : triggers.length === 0 ? (
              <p className="py-4 text-center text-sm italic text-paddock-400">No triggers yet.</p>
            ) : (
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[54rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-paddock-200 text-left text-[11px] font-semibold uppercase tracking-wide text-paddock-400 dark:border-paddock-800">
                      <th className="px-2 py-2 font-semibold">Trigger</th>
                      <th className="px-2 py-2 font-semibold">Type</th>
                      <th className="px-2 py-2 font-semibold">When</th>
                      <th className="px-2 py-2 font-semibold">Capability</th>
                      <th className="px-2 py-2 font-semibold">Last run</th>
                      <th className="px-2 py-2 font-semibold">Next run</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {triggers.map((t) => {
                      const rt = runtime[t.name];
                      return (
                      <tr
                        key={t.name}
                        data-trigger={t.name}
                        className="border-b border-paddock-100 last:border-0 dark:border-paddock-800/60"
                      >
                        <td className="px-2 py-2.5 align-top">
                          <span className="font-medium text-paddock-800 dark:text-paddock-100">
                            {t.name}
                          </span>
                          {t.run.promptFile ? (
                            <span
                              className="mt-0.5 block font-mono text-[11px] text-paddock-400"
                              title="Prompt read from this file at fire time"
                            >
                              {t.run.promptFile}
                            </span>
                          ) : (
                            t.run.prompt && (
                              <span className="mt-0.5 block max-w-[16rem] truncate text-[11px] text-paddock-400">
                                {t.run.prompt}
                              </span>
                            )
                          )}
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <TypeBadge type={t.trigger.type} />
                        </td>
                        <td className="px-2 py-2.5 align-top font-mono text-[12px] text-paddock-600 dark:text-paddock-300">
                          {whenSummary(t.trigger)}
                        </td>
                        <td className="px-2 py-2.5 align-top text-[12px] text-paddock-600 dark:text-paddock-300">
                          <span title={t.run.tools?.join(", ") || "No tools granted"}>
                            {capabilitySummary(t)}
                          </span>
                          {t.run.permissionMode && (
                            <span className="mt-0.5 block text-[11px] text-paddock-400">
                              {t.run.permissionMode}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 align-top" data-trigger-lastrun={t.name}>
                          <LastRunCell rt={rt} />
                        </td>
                        <td className="px-2 py-2.5 align-top" data-trigger-nextrun={t.name}>
                          <NextRunCell rt={rt} trigger={t} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <StatusChip enabled={t.enabled === true} running={rt?.running === true} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => runNow(t)}
                              disabled={busy === t.name}
                              title="Run now"
                              aria-label={`Run ${t.name} now`}
                              data-testid={`run-trigger-${t.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-accent transition hover:bg-accent/10 disabled:opacity-40"
                            >
                              <PlayIcon width={13} height={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggle(t)}
                              disabled={busy === t.name}
                              className="rounded-md px-1.5 py-1 text-[12px] font-medium text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                              title={t.enabled ? "Disable" : "Enable"}
                            >
                              {t.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ isNew: false, draft: draftFrom(t) })}
                              disabled={busy === t.name}
                              title="Edit"
                              aria-label={`Edit ${t.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                            >
                              <PencilIcon width={14} height={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(t)}
                              disabled={busy === t.name}
                              title="Delete"
                              aria-label={`Delete ${t.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-400 transition hover:bg-rose-100 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                            >
                              <TrashIcon width={14} height={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Create button (only when the editor is closed). */}
            {!editing && (
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    isNew: true,
                    draft: blankDraft(types[0] ?? "schedule", events[0] ?? "onArchive"),
                  })
                }
                className="btn-subtle mt-3 gap-1.5 px-2 py-1 text-xs"
                data-testid="add-trigger"
              >
                <PlusIcon width={13} height={13} />
                Add trigger
              </button>
            )}

            {/* Inline editor for create / edit. */}
            {editing && draft && (
              <div
                className="mt-4 rounded-xl border border-paddock-200 bg-paddock-50/60 p-4 dark:border-paddock-800 dark:bg-paddock-950/40"
                data-testid="trigger-editor"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-paddock-700 dark:text-paddock-200">
                    {editing.isNew ? "New trigger" : `Edit “${draft.name}”`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    aria-label="Cancel"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-400 hover:bg-paddock-200/60 dark:hover:bg-paddock-800/60"
                  >
                    <XIcon width={14} height={14} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                  <label className="block">
                    <span className="field-label">Name</span>
                    <input
                      className="input"
                      value={draft.name}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      placeholder="daily-manager"
                      disabled={!editing.isNew}
                      aria-invalid={nameInvalid || nameTaken}
                      data-testid="trigger-name"
                    />
                    {editing.isNew && nameTaken ? (
                      <p className="mt-1 text-[12px] text-rose-500">A trigger with that name exists.</p>
                    ) : editing.isNew && draft.name.trim() && nameInvalid ? (
                      <p className="mt-1 text-[12px] text-rose-500">
                        Letters, numbers, <code>. _ -</code> only (max 64).
                      </p>
                    ) : (
                      !editing.isNew && (
                        <p className="mt-1 text-[12px] text-paddock-400">
                          Rename by deleting and recreating.
                        </p>
                      )
                    )}
                  </label>

                  <label className="block">
                    <span className="field-label">Type</span>
                    <select
                      className="input"
                      value={draft.type}
                      onChange={(e) => patchDraft({ type: e.target.value as TriggerType })}
                      data-testid="trigger-type"
                    >
                      {types.map((ty) => (
                        <option key={ty} value={ty}>
                          {TYPE_LABELS[ty] ?? ty}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* WHEN — the discriminated firing condition. */}
                  {draft.type === "schedule" && (
                    <>
                      <label className="block">
                        <span className="field-label">Timer</span>
                        <select
                          className="input"
                          value={draft.scheduleKind}
                          onChange={(e) =>
                            patchDraft({ scheduleKind: e.target.value as "cron" | "interval", expr: "" })
                          }
                          data-testid="trigger-schedule-kind"
                        >
                          <option value="interval">Interval (every N)</option>
                          <option value="cron">Cron</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="field-label">
                          {draft.scheduleKind === "cron" ? "Cron expression" : "Interval"}
                        </span>
                        <input
                          className="input font-mono"
                          value={draft.expr}
                          onChange={(e) => patchDraft({ expr: e.target.value })}
                          placeholder={draft.scheduleKind === "cron" ? "0 9 * * *" : "30m"}
                          aria-invalid={whenInvalid}
                          data-testid="trigger-expr"
                        />
                        <p className="mt-1 text-[12px] text-paddock-400">
                          {draft.scheduleKind === "cron"
                            ? "5-field cron (or @daily / @hourly), host-local time."
                            : "A duration like 30m, 1h, or 6h."}
                        </p>
                      </label>
                    </>
                  )}

                  {draft.type === "event" && (
                    <label className="col-span-1 block">
                      <span className="field-label">Event</span>
                      <select
                        className="input"
                        value={draft.event}
                        onChange={(e) => patchDraft({ event: e.target.value as TriggerEvent })}
                        data-testid="trigger-event"
                      >
                        {events.map((ev) => (
                          <option key={ev} value={ev}>
                            {EVENT_LABELS[ev] ?? ev}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {draft.type === "webhook" && (
                    <label className="col-span-1 block">
                      <span className="field-label">Path</span>
                      <input
                        className="input font-mono"
                        value={draft.path}
                        onChange={(e) => patchDraft({ path: e.target.value })}
                        placeholder="/gh/issues"
                        data-testid="trigger-path"
                      />
                    </label>
                  )}

                  {/* Reserved-webhook notice: the shape is shown but the ingress isn't built (T6). */}
                  {webhookReserved && (
                    <p className="col-span-2 flex items-start gap-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
                      <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
                      <span data-testid="trigger-webhook-reserved">
                        Webhook triggers are <strong>reserved</strong> — the inbound HTTP ingress
                        isn’t built yet, so a webhook trigger can’t be created here. The shape is
                        shown for reference.
                      </span>
                    </p>
                  )}

                  {/* Prompt. */}
                  <div className="col-span-2 block">
                    <span className="field-label">Prompt</span>
                    <div className="mb-2 flex gap-3 text-[13px]">
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          className="accent-accent"
                          checked={draft.promptMode === "inline"}
                          onChange={() => patchDraft({ promptMode: "inline" })}
                        />
                        Inline text
                      </label>
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          className="accent-accent"
                          checked={draft.promptMode === "file"}
                          onChange={() => patchDraft({ promptMode: "file" })}
                        />
                        Prompt file
                      </label>
                    </div>
                    {draft.promptMode === "inline" ? (
                      <textarea
                        className="input min-h-[5rem] resize-y"
                        value={draft.prompt}
                        onChange={(e) => patchDraft({ prompt: e.target.value })}
                        placeholder="What should this trigger do when it fires?"
                        aria-invalid={promptInvalid}
                        data-testid="trigger-prompt"
                      />
                    ) : (
                      <>
                        <input
                          className="input font-mono"
                          value={draft.promptFile}
                          onChange={(e) => patchDraft({ promptFile: e.target.value })}
                          placeholder="daily-manager.md"
                          aria-invalid={promptInvalid}
                          data-testid="trigger-prompt-file"
                        />
                        <p className="mt-1 text-[12px] text-paddock-400">
                          A <code>.md</code> file under <code>.paddock/triggers/</code>, read fresh
                          each fire (git-tracked, keeper-editable).
                        </p>
                      </>
                    )}
                  </div>

                  {/* Capability picker: tool scope. */}
                  <div className="col-span-2 block">
                    <span className="field-label">Tools</span>
                    <p className="mb-2 text-[12px] text-paddock-400">
                      The trigger agent can use exactly the tools you check here — nothing else.
                      Leave all unchecked for a tool-less trigger that only thinks and returns text
                      {draft.type === "schedule"
                        ? " (a schedule with no tools runs as the keeper with its full toolset)."
                        : "."}
                    </p>
                    <div className="space-y-3" data-testid="trigger-tools">
                      {GROUP_ORDER.filter((g) => grantableTools.some((t) => t.group === g)).map(
                        (group) => (
                          <fieldset key={group}>
                            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-paddock-400">
                              {GROUP_LABELS[group]}
                            </legend>
                            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                              {grantableTools
                                .filter((t) => t.group === group)
                                .map((t) => (
                                  <label
                                    key={t.name}
                                    className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-paddock-100/60 dark:hover:bg-paddock-800/40"
                                    title={t.description}
                                  >
                                    <input
                                      type="checkbox"
                                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                                      checked={draft.allowedTools.has(t.name)}
                                      onChange={() => toggleTool(t.name)}
                                      data-tool={t.name}
                                    />
                                    <span className="min-w-0">
                                      <span className="font-mono text-[12px] font-medium text-paddock-700 dark:text-paddock-200">
                                        {t.name}
                                      </span>
                                      <span className="block text-[11px] leading-snug text-paddock-400">
                                        {t.description}
                                      </span>
                                    </span>
                                  </label>
                                ))}
                            </div>
                          </fieldset>
                        ),
                      )}
                    </div>
                    {draft.allowedTools.has("Bash") && (
                      <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
                        <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
                        <span>
                          <code>Bash</code> lets this trigger run arbitrary shell commands in the
                          project working dir. Grant it only when the trigger genuinely needs it.
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Session mode. */}
                  <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent"
                        checked={draft.resumeSession}
                        onChange={(e) => patchDraft({ resumeSession: e.target.checked })}
                        data-testid="trigger-session"
                      />
                      <span className="text-paddock-700 dark:text-paddock-200">
                        Accrete into one session
                      </span>
                    </label>
                    <span className="text-[12px] text-paddock-400">
                      {draft.resumeSession
                        ? "One long-lived chat that accretes across fires."
                        : "A fresh chat each fire."}
                    </span>
                  </div>

                  {/* Advanced capability knobs. */}
                  <label className="block">
                    <span className="field-label">Permission mode</span>
                    <select
                      className="input"
                      value={draft.permissionMode}
                      onChange={(e) =>
                        patchDraft({ permissionMode: e.target.value as "" | TriggerPermissionMode })
                      }
                      data-testid="trigger-permission-mode"
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="field-label">Max turns</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      className="input"
                      value={draft.maxTurns}
                      onChange={(e) => patchDraft({ maxTurns: e.target.value })}
                      placeholder="30"
                      data-testid="trigger-max-turns"
                    />
                  </label>

                  <label className="block">
                    <span className="field-label">Model</span>
                    <input
                      className="input"
                      value={draft.model}
                      onChange={(e) => patchDraft({ model: e.target.value })}
                      placeholder="Keeper default"
                      data-testid="trigger-model"
                    />
                  </label>

                  <label className="block">
                    <span className="field-label">Max spawn depth</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="input"
                      value={draft.maxSpawnDepth}
                      onChange={(e) => patchDraft({ maxSpawnDepth: e.target.value })}
                      placeholder="Inherit"
                      data-testid="trigger-max-spawn-depth"
                    />
                    <p className="mt-1 text-[12px] text-paddock-400">
                      0 = may not spawn children.
                    </p>
                  </label>

                  <label className="col-span-2 inline-flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={draft.enabled}
                      onChange={(e) => patchDraft({ enabled: e.target.checked })}
                      data-testid="trigger-enabled"
                    />
                    <span className="text-paddock-700 dark:text-paddock-200">
                      Enabled (fires on its trigger)
                    </span>
                  </label>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={saveDraft}
                    disabled={formInvalid || busy === draft.name.trim()}
                    className="btn-primary"
                    data-testid="trigger-save"
                  >
                    {busy === draft.name.trim()
                      ? "Saving…"
                      : editing.isNew
                        ? "Create trigger"
                        : "Save"}
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** A small badge coloring the trigger's type (schedule / event / webhook). */
function TypeBadge({ type }: { type: TriggerType }) {
  const map: Record<TriggerType, string> = {
    schedule: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
    event: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
    webhook: "bg-paddock-200 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400",
  };
  const Icon = type === "schedule" ? ClockIcon : BoltIcon;
  return (
    <span
      data-trigger-type={type}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${map[type]}`}
    >
      <Icon width={11} height={11} />
      {type}
    </span>
  );
}

/**
 * A small status chip. A live run wins the display (an amber pulsing "Running" chip),
 * otherwise it reflects the armed state: enabled (green) vs disabled (grey).
 */
function StatusChip({ enabled, running }: { enabled: boolean; running?: boolean }) {
  if (running) {
    return (
      <span
        data-trigger-status="running"
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Running
      </span>
    );
  }
  return (
    <span
      data-trigger-status={enabled ? "enabled" : "disabled"}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        enabled
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "bg-paddock-200 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400"
      }`}
    >
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

/** Colour for a run status: green success, rose failure/cancel, amber running, grey else. */
function runStatusClass(status: string): string {
  if (status === "completed") return "bg-emerald-500";
  if (status === "failed" || status === "cancelled") return "bg-rose-500";
  if (status === "running" || status === "pending") return "bg-amber-500";
  return "bg-paddock-400";
}

/**
 * The "Last run" cell: a coloured status dot + a relative time, titled with the
 * absolute time, terminal status, and the run's summary. "—" when a trigger has never
 * fired (its runtime hasn't loaded, or it has no attributable run yet).
 */
function LastRunCell({ rt }: { rt?: TriggerRuntime }) {
  const last = rt?.lastRun;
  if (!last) return <span className="text-[12px] text-paddock-400">—</span>;
  const when = last.startedAt;
  const title = [
    when ? new Date(when).toLocaleString() : null,
    `status: ${last.status}${last.exitReason ? ` (${last.exitReason})` : ""}`,
    last.summary ?? null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-paddock-600 dark:text-paddock-300" title={title}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${runStatusClass(last.status)}`} />
      {last.status === "running" ? "Running…" : relativeTime(when)}
    </span>
  );
}

/**
 * The "Next run" cell: for a SCHEDULE trigger, the relative time until its next cron
 * fire (titled with the absolute time), or "—" when it's disabled/unarmed. Event and
 * webhook triggers have no scheduled fire — they show a muted "on event" / "on webhook".
 */
function NextRunCell({ rt, trigger }: { rt?: TriggerRuntime; trigger: Trigger }) {
  const type = trigger.trigger.type;
  if (type === "event") {
    return <span className="text-[12px] text-paddock-400">on event</span>;
  }
  if (type === "webhook") {
    return <span className="text-[12px] text-paddock-400">on webhook</span>;
  }
  const next = rt?.nextRunAt;
  if (!next) return <span className="text-[12px] text-paddock-400">—</span>;
  return (
    <span
      className="text-[12px] text-paddock-600 dark:text-paddock-300"
      title={new Date(next).toLocaleString()}
    >
      {untilTime(next)}
    </span>
  );
}
