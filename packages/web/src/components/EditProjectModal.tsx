import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project, ProjectStatus } from "../lib/types";
import { XIcon } from "./icons";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done", "abandoned"];

/**
 * Edit a project's mutable metadata (status, summary, domain tags). The slug
 * and dates are immutable server-side, so they're not editable here.
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
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields from the project each time the modal opens.
  useEffect(() => {
    if (open) {
      setSummary(project.summary);
      setDomain(project.domain.join(", "));
      setStatus(project.status);
      setError(null);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose, project]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateProject(project.slug, {
        status,
        summary: summary.trim(),
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
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
