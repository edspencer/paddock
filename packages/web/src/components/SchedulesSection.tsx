import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project, Schedule, ScheduleInput, ScheduleType } from "../lib/types";
import { relativeTime } from "../lib/format";
import { ClockIcon, PencilIcon, PlusIcon, SparkIcon, TrashIcon, XIcon } from "./icons";

/** A valid schedule name / herdctl key (mirrors the server's `isValidScheduleName`). */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The editor's working copy of a schedule (flattened for the form controls). */
interface Draft {
  name: string;
  type: ScheduleType;
  /** The cron expression or interval string, depending on `type`. */
  expr: string;
  promptMode: "inline" | "file";
  prompt: string;
  promptFile: string;
  resumeSession: boolean;
  enabled: boolean;
}

function blankDraft(): Draft {
  return {
    name: "",
    type: "interval",
    expr: "",
    promptMode: "inline",
    prompt: "",
    promptFile: "",
    resumeSession: false,
    enabled: true,
  };
}

/** Prefill the editor from an existing schedule (its name is then read-only). */
function draftFrom(s: Schedule): Draft {
  return {
    name: s.name,
    type: s.type,
    expr: s.type === "cron" ? (s.cron ?? "") : (s.interval ?? ""),
    promptMode: s.promptFile ? "file" : "inline",
    prompt: s.prompt ?? "",
    promptFile: s.promptFile ?? "",
    resumeSession: s.resumeSession,
    enabled: s.enabled,
  };
}

/** Project a {@link Draft} onto the server's write shape. */
function toInput(d: Draft): ScheduleInput {
  const input: ScheduleInput = {
    type: d.type,
    resume_session: d.resumeSession,
    enabled: d.enabled,
  };
  if (d.type === "cron") input.cron = d.expr.trim();
  else input.interval = d.expr.trim();
  if (d.promptMode === "file") input.promptFile = d.promptFile.trim();
  else input.prompt = d.prompt;
  return input;
}

/** A small status chip mirroring herdctl's ScheduleList status column. */
function StatusChip({ status }: { status: Schedule["status"] }) {
  const map: Record<Schedule["status"], string> = {
    running: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
    idle: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    disabled: "bg-paddock-200 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400",
  };
  return (
    <span
      data-schedule-status={status}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${map[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * The Schedules section of the project Settings tab (issue #266 / D4). Lists a
 * project's scheduled chats — the project.yaml declaration merged with herdctl's
 * live runtime state — and lets an operator create / edit / delete them, toggle
 * enabled, and "trigger now" (which fires the schedule through the same hub path a
 * cron uses, so the run shows up as a first-class `scheduled`-badged chat).
 *
 * Its mutations run through dedicated endpoints (immediate, NOT the Settings save
 * bar), so this manages its own state. When the deployment hasn't opted into
 * schedule mutation (`PADDOCK_SCHEDULE_MUTATION` off) the list renders read-only
 * with a hint; trigger-now stays available (it runs a declared schedule, it
 * doesn't change the set).
 *
 * Column layout borrows herdctl web's ScheduleList (Schedule | Type | Expression |
 * Status | Last / Next run | Actions), dropping the Agent column since every row
 * belongs to this project's one keeper.
 */
export function SchedulesSection({ project }: { project: Project }) {
  const slug = project.slug;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [mutationEnabled, setMutationEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The row currently being created/edited. `isNew` locks the name field open;
  // editing an existing schedule keeps its name (renaming = delete + recreate).
  const [editing, setEditing] = useState<{ isNew: boolean; draft: Draft } | null>(null);
  // The schedule name a per-row action is in flight for (disables that row's buttons).
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listSchedules(slug);
      setSchedules(r.schedules);
      setMutationEnabled(r.mutationEnabled);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the transient "triggered / saved" notice a moment after it appears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const draft = editing?.draft;
  const nameTaken = useMemo(
    () => (editing?.isNew ? schedules.some((s) => s.name === draft?.name.trim()) : false),
    [editing, draft, schedules],
  );
  const nameInvalid = !!draft && (!NAME_RE.test(draft.name.trim()) || draft.name.trim().length > 64);
  const exprInvalid = !!draft && draft.expr.trim().length === 0;
  const promptInvalid =
    !!draft &&
    (draft.promptMode === "file"
      ? draft.promptFile.trim().length === 0 || !draft.promptFile.trim().toLowerCase().endsWith(".md")
      : draft.prompt.trim().length === 0);
  const formInvalid = nameInvalid || nameTaken || exprInvalid || promptInvalid;

  const patchDraft = (p: Partial<Draft>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));

  const saveDraft = async () => {
    if (!editing || formInvalid) return;
    const name = editing.draft.name.trim();
    setBusy(name);
    try {
      await api.putSchedule(slug, name, toInput(editing.draft));
      setEditing(null);
      setNotice(`Saved “${name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save schedule");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (s: Schedule) => {
    setBusy(s.name);
    try {
      const updated = await api.setScheduleEnabled(slug, s.name, !s.enabled);
      setSchedules((prev) => prev.map((x) => (x.name === s.name ? updated : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update schedule");
    } finally {
      setBusy(null);
    }
  };

  const trigger = async (s: Schedule) => {
    setBusy(s.name);
    try {
      await api.triggerSchedule(slug, s.name);
      setNotice(`Triggered “${s.name}” — a scheduled chat is starting.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to trigger schedule");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: Schedule) => {
    if (!window.confirm(`Delete schedule “${s.name}”? This can’t be undone.`)) return;
    setBusy(s.name);
    try {
      await api.deleteSchedule(slug, s.name);
      setSchedules((prev) => prev.filter((x) => x.name !== s.name));
      setNotice(`Deleted “${s.name}”.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete schedule");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-6" data-testid="schedules-section">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-paddock-500">
        <ClockIcon width={14} height={14} />
        Schedules
      </h3>
      <p className="mb-3 mt-0.5 text-[13px] text-paddock-500">
        Chats a schedule starts instead of a person — a cron/interval fires the keeper on a prompt,
        and you can open the resulting chat and carry on. Each schedule either starts a fresh chat
        every fire or accretes into one long-lived session.
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

        {!mutationEnabled && (
          <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
            <ClockIcon width={13} height={13} className="mt-0.5 shrink-0" />
            <span>
              Schedule editing is disabled on this deployment (<code>PADDOCK_SCHEDULE_MUTATION</code>{" "}
              is off). Schedules are read-only here, though you can still trigger a declared one now.
            </span>
          </p>
        )}

        {loading ? (
          <p className="py-4 text-center text-sm text-paddock-400">Loading schedules…</p>
        ) : schedules.length === 0 ? (
          <p className="py-4 text-center text-sm italic text-paddock-400">No schedules yet.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-paddock-200 text-left text-[11px] font-semibold uppercase tracking-wide text-paddock-400 dark:border-paddock-800">
                  <th className="px-2 py-2 font-semibold">Schedule</th>
                  <th className="px-2 py-2 font-semibold">Type</th>
                  <th className="px-2 py-2 font-semibold">Expression</th>
                  <th className="px-2 py-2 font-semibold">Session</th>
                  <th className="px-2 py-2 font-semibold">Status</th>
                  <th className="px-2 py-2 font-semibold">Last / Next run</th>
                  <th className="px-2 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr
                    key={s.name}
                    data-schedule={s.name}
                    className="border-b border-paddock-100 last:border-0 dark:border-paddock-800/60"
                  >
                    <td className="px-2 py-2.5 align-top">
                      <span className="font-medium text-paddock-800 dark:text-paddock-100">
                        {s.name}
                      </span>
                      {s.promptFile ? (
                        <span
                          className="mt-0.5 block font-mono text-[11px] text-paddock-400"
                          title="Prompt read from this file at fire time"
                        >
                          {s.promptFile}
                        </span>
                      ) : (
                        s.prompt && (
                          <span className="mt-0.5 block max-w-[16rem] truncate text-[11px] text-paddock-400">
                            {s.prompt}
                          </span>
                        )
                      )}
                    </td>
                    <td className="px-2 py-2.5 align-top capitalize text-paddock-600 dark:text-paddock-300">
                      {s.type}
                    </td>
                    <td className="px-2 py-2.5 align-top font-mono text-[12px] text-paddock-600 dark:text-paddock-300">
                      {s.type === "cron" ? s.cron : s.interval}
                    </td>
                    <td className="px-2 py-2.5 align-top text-[12px] text-paddock-600 dark:text-paddock-300">
                      {s.resumeSession ? "One session" : "New chat"}
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      <StatusChip status={s.status} />
                    </td>
                    <td className="px-2 py-2.5 align-top text-[12px] text-paddock-500">
                      <span title={s.lastRunAt ?? undefined}>
                        {s.lastRunAt ? relativeTime(s.lastRunAt) : "never"}
                      </span>
                      <span className="text-paddock-300"> / </span>
                      <span title={s.nextRunAt ?? undefined}>
                        {s.nextRunAt ? relativeTime(s.nextRunAt) : "—"}
                      </span>
                      {s.lastError && (
                        <span className="mt-0.5 block max-w-[14rem] truncate text-[11px] text-rose-500" title={s.lastError}>
                          {s.lastError}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => trigger(s)}
                          disabled={busy === s.name}
                          title="Trigger now"
                          aria-label={`Trigger ${s.name} now`}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-500 transition hover:bg-accent/10 hover:text-accent disabled:opacity-40"
                        >
                          <SparkIcon width={14} height={14} />
                        </button>
                        {mutationEnabled && (
                          <>
                            <button
                              type="button"
                              onClick={() => toggle(s)}
                              disabled={busy === s.name}
                              className="rounded-md px-1.5 py-1 text-[12px] font-medium text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                              title={s.enabled ? "Disable" : "Enable"}
                            >
                              {s.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ isNew: false, draft: draftFrom(s) })}
                              disabled={busy === s.name}
                              title="Edit"
                              aria-label={`Edit ${s.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                            >
                              <PencilIcon width={14} height={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(s)}
                              disabled={busy === s.name}
                              title="Delete"
                              aria-label={`Delete ${s.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-400 transition hover:bg-rose-100 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                            >
                              <TrashIcon width={14} height={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create button (only when the editor is closed and mutation is allowed). */}
        {mutationEnabled && !editing && (
          <button
            type="button"
            onClick={() => setEditing({ isNew: true, draft: blankDraft() })}
            className="btn-subtle mt-3 gap-1.5 px-2 py-1 text-xs"
            data-testid="add-schedule"
          >
            <PlusIcon width={13} height={13} />
            Add schedule
          </button>
        )}

        {/* Inline editor for create / edit. */}
        {editing && draft && (
          <div
            className="mt-4 rounded-xl border border-paddock-200 bg-paddock-50/60 p-4 dark:border-paddock-800 dark:bg-paddock-950/40"
            data-testid="schedule-editor"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-paddock-700 dark:text-paddock-200">
                {editing.isNew ? "New schedule" : `Edit “${draft.name}”`}
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
                  placeholder="daily-triage"
                  disabled={!editing.isNew}
                  aria-invalid={nameInvalid || nameTaken}
                  data-testid="schedule-name"
                />
                {editing.isNew && nameTaken ? (
                  <p className="mt-1 text-[12px] text-rose-500">A schedule with that name exists.</p>
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
                  onChange={(e) => patchDraft({ type: e.target.value as ScheduleType, expr: "" })}
                >
                  <option value="interval">Interval (every N)</option>
                  <option value="cron">Cron</option>
                </select>
              </label>

              <label className="col-span-2 block">
                <span className="field-label">
                  {draft.type === "cron" ? "Cron expression" : "Interval"}
                </span>
                <input
                  className="input font-mono"
                  value={draft.expr}
                  onChange={(e) => patchDraft({ expr: e.target.value })}
                  placeholder={draft.type === "cron" ? "0 9 * * *" : "30m"}
                  aria-invalid={exprInvalid}
                  data-testid="schedule-expr"
                />
                <p className="mt-1 text-[12px] text-paddock-400">
                  {draft.type === "cron"
                    ? "5-field cron (or @daily / @hourly), host-local time."
                    : "A duration like 30m, 1h, or 6h."}
                </p>
              </label>

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
                    placeholder="What should the keeper do when this fires?"
                    aria-invalid={promptInvalid}
                    data-testid="schedule-prompt"
                  />
                ) : (
                  <>
                    <input
                      className="input font-mono"
                      value={draft.promptFile}
                      onChange={(e) => patchDraft({ promptFile: e.target.value })}
                      placeholder="triage.md"
                      aria-invalid={promptInvalid}
                      data-testid="schedule-prompt-file"
                    />
                    <p className="mt-1 text-[12px] text-paddock-400">
                      A <code>.md</code> file under <code>.paddock/schedules/</code>, read fresh each
                      fire (git-tracked, keeper-editable).
                    </p>
                  </>
                )}
              </div>

              <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={draft.resumeSession}
                    onChange={(e) => patchDraft({ resumeSession: e.target.checked })}
                    data-testid="schedule-resume"
                  />
                  <span className="text-paddock-700 dark:text-paddock-200">
                    Accrete into one session
                  </span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={draft.enabled}
                    onChange={(e) => patchDraft({ enabled: e.target.checked })}
                  />
                  <span className="text-paddock-700 dark:text-paddock-200">Enabled</span>
                </label>
                <span className="text-[12px] text-paddock-400">
                  {draft.resumeSession
                    ? "One long-lived chat that accretes across fires."
                    : "A fresh chat each fire."}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={saveDraft}
                disabled={formInvalid || busy === draft.name.trim()}
                className="btn-primary"
                data-testid="schedule-save"
              >
                {busy === draft.name.trim() ? "Saving…" : editing.isNew ? "Create schedule" : "Save"}
              </button>
              <button type="button" onClick={() => setEditing(null)} className="btn-ghost">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
