import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type {
  GrantableTool,
  Hook,
  HookCapabilities,
  HookEvent,
  HookInput,
  HookPermissionMode,
  Project,
} from "../lib/types";
import { AlertIcon, BoltIcon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "./icons";

/** A valid hook name / herdctl key segment (mirrors the server's `isValidHookName`). */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Human labels for each lifecycle event the server knows about. */
const EVENT_LABELS: Record<HookEvent, string> = {
  onArchive: "On archive — a chat is archived",
};

/** Permission modes offered in the picker (mirrors the server's PERMISSION_MODES). */
const PERMISSION_MODES: { value: "" | HookPermissionMode; label: string }[] = [
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

/** The editor's flattened working copy of a hook. */
interface Draft {
  name: string;
  event: HookEvent;
  promptMode: "inline" | "file";
  prompt: string;
  promptFile: string;
  /** Selected `allowedTools` (the effective grant). */
  allowedTools: Set<string>;
  /** Comma/space-separated denied-tool patterns (advanced). */
  deniedTools: string;
  /** "" = don't set (fleet default). */
  permissionMode: "" | HookPermissionMode;
  /** "" = keeper default model. */
  model: string;
  /** "" = server default (30). */
  maxTurns: string;
  enabled: boolean;
}

function blankDraft(event: HookEvent): Draft {
  return {
    name: "",
    event,
    promptMode: "inline",
    prompt: "",
    promptFile: "",
    allowedTools: new Set(),
    deniedTools: "",
    permissionMode: "",
    model: "",
    maxTurns: "",
    // New hooks are DISABLED by default (GG-3) — nothing fires the instant it's saved.
    enabled: false,
  };
}

/** Prefill the editor from an existing hook (its name is then read-only). */
function draftFrom(h: Hook): Draft {
  const caps = h.capabilities ?? {};
  return {
    name: h.name,
    event: h.event,
    promptMode: h.promptFile ? "file" : "inline",
    prompt: h.prompt ?? "",
    promptFile: h.promptFile ?? "",
    allowedTools: new Set(caps.allowedTools ?? []),
    deniedTools: (caps.deniedTools ?? []).join(", "),
    permissionMode: caps.permissionMode ?? "",
    model: caps.model ?? "",
    maxTurns: caps.maxTurns != null ? String(caps.maxTurns) : "",
    enabled: h.enabled === true,
  };
}

/** Split a comma/space/newline-separated tool list into trimmed non-empty patterns. */
function parseToolList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Project a {@link Draft} onto the server's write shape. */
function toInput(d: Draft): HookInput {
  const caps: HookCapabilities = {};
  if (d.allowedTools.size > 0) caps.allowedTools = [...d.allowedTools];
  const denied = parseToolList(d.deniedTools);
  if (denied.length > 0) caps.deniedTools = denied;
  if (d.permissionMode) caps.permissionMode = d.permissionMode;
  if (d.model.trim()) caps.model = d.model.trim();
  const turns = Number(d.maxTurns);
  if (d.maxTurns.trim() && Number.isFinite(turns) && turns > 0) caps.maxTurns = Math.floor(turns);

  const input: HookInput = { event: d.event, enabled: d.enabled };
  if (Object.keys(caps).length > 0) input.capabilities = caps;
  if (d.promptMode === "file") input.promptFile = d.promptFile.trim();
  else input.prompt = d.prompt;
  return input;
}

/** A compact one-line summary of a hook's granted tools, for the list. */
function capabilitySummary(h: Hook): string {
  const tools = h.capabilities?.allowedTools ?? [];
  if (tools.length === 0) return "Tool-less";
  return `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
}

/**
 * The per-project Hooks tab (Epic G / G4). Lists a project's event hooks — an
 * event-triggered agent (`hook-<slug>-<name>`) whose tool config IS its capability
 * (GG-1) — and lets an operator create / edit / delete them, toggle enabled, and
 * pick a precise capability set (event, tool scope, permission mode, model, max
 * turns, and an inline or `.paddock/hooks/*.md` prompt).
 *
 * Enable/disable is NOT a separate verb — it's a `set` (PUT) with the `enabled`
 * field flipped (GG-3); new hooks are created DISABLED so nothing fires the instant
 * one is written. All mutations run through their own endpoints (immediate), so the
 * pane manages its own state, like the Schedules section.
 */
export function HooksPane({ project }: { project: Project }) {
  const slug = project.slug;
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [grantableTools, setGrantableTools] = useState<GrantableTool[]>([]);
  const [events, setEvents] = useState<HookEvent[]>(["onArchive"]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ isNew: boolean; draft: Draft } | null>(null);
  // The hook name a per-row action is in flight for (disables that row's buttons).
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listHooks(slug);
      setHooks(r.hooks);
      setGrantableTools(r.grantableTools);
      if (r.events.length > 0) setEvents(r.events);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load hooks");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the transient "saved / deleted" notice a moment after it appears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const draft = editing?.draft;
  const nameTaken = useMemo(
    () => (editing?.isNew ? hooks.some((h) => h.name === draft?.name.trim()) : false),
    [editing, draft, hooks],
  );
  const nameInvalid = !!draft && (!NAME_RE.test(draft.name.trim()) || draft.name.trim().length > 64);
  const promptInvalid =
    !!draft &&
    (draft.promptMode === "file"
      ? draft.promptFile.trim().length === 0 || !draft.promptFile.trim().toLowerCase().endsWith(".md")
      : draft.prompt.trim().length === 0);
  const formInvalid = nameInvalid || nameTaken || promptInvalid;

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
      await api.putHook(slug, name, toInput(editing.draft));
      setEditing(null);
      setNotice(`Saved “${name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save hook");
    } finally {
      setBusy(null);
    }
  };

  // Enable/disable is just a `set` with `enabled` flipped (GG-3) — no separate verb.
  const toggle = async (h: Hook) => {
    setBusy(h.name);
    try {
      const updated = await api.putHook(slug, h.name, { ...toInput(draftFrom(h)), enabled: !h.enabled });
      setHooks((prev) => prev.map((x) => (x.name === h.name ? updated : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update hook");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (h: Hook) => {
    if (!window.confirm(`Delete hook “${h.name}”? This can’t be undone.`)) return;
    setBusy(h.name);
    try {
      await api.deleteHook(slug, h.name);
      setHooks((prev) => prev.filter((x) => x.name !== h.name));
      setNotice(`Deleted “${h.name}”.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete hook");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="hooks-pane">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <section className="mb-6">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            <BoltIcon width={14} height={14} />
            Hooks
          </h3>
          <p className="mb-3 mt-0.5 text-[13px] text-paddock-500">
            An event hook runs an agent turn when a lifecycle event happens (e.g. a chat is
            archived). Each hook is its own agent whose granted tools <em>are</em> its capability —
            pick exactly what it can do. New hooks are created disabled; enable one when you’re ready
            for it to fire.
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
              <p className="py-4 text-center text-sm text-paddock-400">Loading hooks…</p>
            ) : hooks.length === 0 ? (
              <p className="py-4 text-center text-sm italic text-paddock-400">No hooks yet.</p>
            ) : (
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-paddock-200 text-left text-[11px] font-semibold uppercase tracking-wide text-paddock-400 dark:border-paddock-800">
                      <th className="px-2 py-2 font-semibold">Hook</th>
                      <th className="px-2 py-2 font-semibold">Event</th>
                      <th className="px-2 py-2 font-semibold">Capability</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hooks.map((h) => (
                      <tr
                        key={h.name}
                        data-hook={h.name}
                        className="border-b border-paddock-100 last:border-0 dark:border-paddock-800/60"
                      >
                        <td className="px-2 py-2.5 align-top">
                          <span className="font-medium text-paddock-800 dark:text-paddock-100">
                            {h.name}
                          </span>
                          {h.promptFile ? (
                            <span
                              className="mt-0.5 block font-mono text-[11px] text-paddock-400"
                              title="Prompt read from this file at fire time"
                            >
                              {h.promptFile}
                            </span>
                          ) : (
                            h.prompt && (
                              <span className="mt-0.5 block max-w-[16rem] truncate text-[11px] text-paddock-400">
                                {h.prompt}
                              </span>
                            )
                          )}
                        </td>
                        <td className="px-2 py-2.5 align-top font-mono text-[12px] text-paddock-600 dark:text-paddock-300">
                          {h.event}
                        </td>
                        <td className="px-2 py-2.5 align-top text-[12px] text-paddock-600 dark:text-paddock-300">
                          <span
                            title={
                              h.capabilities?.allowedTools?.join(", ") || "No tools granted"
                            }
                          >
                            {capabilitySummary(h)}
                          </span>
                          {h.capabilities?.permissionMode && (
                            <span className="mt-0.5 block text-[11px] text-paddock-400">
                              {h.capabilities.permissionMode}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <StatusChip enabled={h.enabled === true} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => toggle(h)}
                              disabled={busy === h.name}
                              className="rounded-md px-1.5 py-1 text-[12px] font-medium text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                              title={h.enabled ? "Disable" : "Enable"}
                            >
                              {h.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ isNew: false, draft: draftFrom(h) })}
                              disabled={busy === h.name}
                              title="Edit"
                              aria-label={`Edit ${h.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-500 transition hover:bg-paddock-200/60 disabled:opacity-40 dark:hover:bg-paddock-800/60"
                            >
                              <PencilIcon width={14} height={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(h)}
                              disabled={busy === h.name}
                              title="Delete"
                              aria-label={`Delete ${h.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-paddock-400 transition hover:bg-rose-100 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                            >
                              <TrashIcon width={14} height={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Create button (only when the editor is closed). */}
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing({ isNew: true, draft: blankDraft(events[0] ?? "onArchive") })}
                className="btn-subtle mt-3 gap-1.5 px-2 py-1 text-xs"
                data-testid="add-hook"
              >
                <PlusIcon width={13} height={13} />
                Add hook
              </button>
            )}

            {/* Inline editor for create / edit. */}
            {editing && draft && (
              <div
                className="mt-4 rounded-xl border border-paddock-200 bg-paddock-50/60 p-4 dark:border-paddock-800 dark:bg-paddock-950/40"
                data-testid="hook-editor"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-paddock-700 dark:text-paddock-200">
                    {editing.isNew ? "New hook" : `Edit “${draft.name}”`}
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
                      placeholder="cleanup"
                      disabled={!editing.isNew}
                      aria-invalid={nameInvalid || nameTaken}
                      data-testid="hook-name"
                    />
                    {editing.isNew && nameTaken ? (
                      <p className="mt-1 text-[12px] text-rose-500">A hook with that name exists.</p>
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
                    <span className="field-label">Event</span>
                    <select
                      className="input"
                      value={draft.event}
                      onChange={(e) => patchDraft({ event: e.target.value as HookEvent })}
                      data-testid="hook-event"
                    >
                      {events.map((ev) => (
                        <option key={ev} value={ev}>
                          {EVENT_LABELS[ev] ?? ev}
                        </option>
                      ))}
                    </select>
                  </label>

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
                        placeholder="What should this hook do when it fires?"
                        aria-invalid={promptInvalid}
                        data-testid="hook-prompt"
                      />
                    ) : (
                      <>
                        <input
                          className="input font-mono"
                          value={draft.promptFile}
                          onChange={(e) => patchDraft({ promptFile: e.target.value })}
                          placeholder="cleanup.md"
                          aria-invalid={promptInvalid}
                          data-testid="hook-prompt-file"
                        />
                        <p className="mt-1 text-[12px] text-paddock-400">
                          A <code>.md</code> file under <code>.paddock/hooks/</code>, read fresh each
                          fire (git-tracked, keeper-editable).
                        </p>
                      </>
                    )}
                  </div>

                  {/* Capability picker: tool scope. */}
                  <div className="col-span-2 block">
                    <span className="field-label">Tools</span>
                    <p className="mb-2 text-[12px] text-paddock-400">
                      The hook agent can use exactly the tools you check here — nothing else. Leave
                      all unchecked for a tool-less hook that only thinks and returns text.
                    </p>
                    <div className="space-y-3" data-testid="hook-tools">
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
                          <code>Bash</code> lets this hook run arbitrary shell commands in the
                          project working dir. Grant it only when the hook genuinely needs it.
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Advanced capability knobs. */}
                  <label className="block">
                    <span className="field-label">Permission mode</span>
                    <select
                      className="input"
                      value={draft.permissionMode}
                      onChange={(e) =>
                        patchDraft({ permissionMode: e.target.value as "" | HookPermissionMode })
                      }
                      data-testid="hook-permission-mode"
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
                      data-testid="hook-max-turns"
                    />
                  </label>

                  <label className="block">
                    <span className="field-label">Model</span>
                    <input
                      className="input"
                      value={draft.model}
                      onChange={(e) => patchDraft({ model: e.target.value })}
                      placeholder="Keeper default"
                      data-testid="hook-model"
                    />
                  </label>

                  <label className="block">
                    <span className="field-label">Denied tools (advanced)</span>
                    <input
                      className="input font-mono"
                      value={draft.deniedTools}
                      onChange={(e) => patchDraft({ deniedTools: e.target.value })}
                      placeholder="Bash(rm -rf *)"
                      data-testid="hook-denied-tools"
                    />
                  </label>

                  <label className="col-span-2 inline-flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={draft.enabled}
                      onChange={(e) => patchDraft({ enabled: e.target.checked })}
                      data-testid="hook-enabled"
                    />
                    <span className="text-paddock-700 dark:text-paddock-200">
                      Enabled (fires on the event)
                    </span>
                  </label>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={saveDraft}
                    disabled={formInvalid || busy === draft.name.trim()}
                    className="btn-primary"
                    data-testid="hook-save"
                  >
                    {busy === draft.name.trim() ? "Saving…" : editing.isNew ? "Create hook" : "Save"}
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

/** A small status chip: enabled (armed) vs disabled. */
function StatusChip({ enabled }: { enabled: boolean }) {
  return (
    <span
      data-hook-status={enabled ? "enabled" : "disabled"}
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
