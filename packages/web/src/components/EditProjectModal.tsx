import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ModelInfo, Project, ProjectStatus } from "../lib/types";
import { AREAS } from "../lib/areas";
import { XIcon } from "./icons";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done", "abandoned"];

/** Keeper permission modes offered here — mirrors the server's PERMISSION_MODES. */
const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only" },
  { value: "bypassPermissions", label: "Bypass all (use with care)" },
];

/**
 * Edit a project's mutable metadata (status, summary, domain tags, area) plus
 * its keeper-agent settings (model, permission mode, max turns, Docker sandbox —
 * issue #12; changing these re-registers the keeper server-side). The slug and
 * dates are immutable server-side, so they're not editable here.
 */
export function EditProjectModal({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [summary, setSummary] = useState(project.summary);
  const [domain, setDomain] = useState(project.domain.join(", "));
  const [group, setGroup] = useState(project.group ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  // Keeper-agent settings (issue #12).
  const [model, setModel] = useState(project.model);
  const [permissionMode, setPermissionMode] = useState(project.permissionMode);
  const [maxTurns, setMaxTurns] = useState(String(project.maxTurns));
  const [docker, setDocker] = useState(project.docker);
  // driveMode (Paddock#111): "" = inherit the box-wide global default.
  const [driveMode, setDriveMode] = useState<string>(project.driveMode ?? "");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields from the project each time the modal opens.
  useEffect(() => {
    if (open) {
      setSummary(project.summary);
      setDomain(project.domain.join(", "));
      setGroup(project.group ?? "");
      setStatus(project.status);
      setModel(project.model);
      setPermissionMode(project.permissionMode);
      setMaxTurns(String(project.maxTurns));
      setDocker(project.docker);
      setDriveMode(project.driveMode ?? "");
      setError(null);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose, project]);

  // Load the selectable models when the modal opens (for the model picker).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .getModels()
      .then((r) => {
        if (!cancelled) setModels(r.models);
      })
      .catch(() => {
        /* non-fatal: the current model is still shown as the selected option */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateProject(project.slug, {
        status,
        group,
        summary: summary.trim(),
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        model,
        permissionMode,
        maxTurns: Number(maxTurns),
        docker,
        // "" clears the per-project override (inherit the global default).
        driveMode: driveMode === "" ? undefined : (driveMode as "batch" | "session"),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save changes");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <form
        className="w-full max-w-md animate-scale-in rounded-2xl border border-paddock-200 bg-white p-6 shadow-2xl dark:border-paddock-800 dark:bg-paddock-900"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-paddock-400 hover:bg-paddock-100 hover:text-paddock-600 dark:hover:bg-paddock-800"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>
        <p className="mb-5 text-sm text-paddock-500">{project.name}</p>

        <label className="mb-4 block">
          <span className="field-label">Summary</span>
          <input
            autoFocus
            className="input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One line on what this project is about"
          />
        </label>

        <label className="mb-4 block">
          <span className="field-label">Area</span>
          <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Unsorted</option>
            {AREAS.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.label}
              </option>
            ))}
            {/* Preserve a custom/legacy area that isn't in the canonical list. */}
            {group && !AREAS.some((a) => a.slug === group) && (
              <option value={group}>{group}</option>
            )}
          </select>
        </label>

        <div className="mb-5 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="field-label">Domain tags</span>
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="home, plumbing"
            />
          </label>
          <label className="block">
            <span className="field-label">Status</span>
            <select
              className="input capitalize"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Keeper-agent settings (issue #12). Changing these re-registers the
            project's keeper agent server-side. */}
        <div className="mb-5 rounded-xl border border-paddock-200 p-3 dark:border-paddock-800">
          <p className="field-label mb-2">Keeper agent</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                {/* Keep the current model selectable even if the list hasn't
                    loaded (or it's since been removed from the picker). */}
                {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">Permission mode</span>
              <select
                className="input"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
              >
                {!PERMISSION_MODES.some((m) => m.value === permissionMode) && (
                  <option value={permissionMode}>{permissionMode}</option>
                )}
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
                max={1000}
                step={1}
                className="input"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-2 self-end pb-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={docker}
                onChange={(e) => setDocker(e.target.checked)}
              />
              <span className="text-sm text-paddock-700 dark:text-paddock-200">Docker sandbox</span>
            </label>
            <label className="block">
              <span className="field-label">Drive mode</span>
              <select
                className="input"
                value={driveMode}
                onChange={(e) => setDriveMode(e.target.value)}
              >
                <option value="">Global default</option>
                <option value="batch">Batch (one-shot per turn)</option>
                <option value="session">Session (cross-turn autonomy)</option>
              </select>
            </label>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
