import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project, ProjectStatus } from "../lib/types";
import { AREAS } from "../lib/areas";
import { XIcon } from "./icons";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done"];

export function NewProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [domain, setDomain] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form ONLY on an open transition. Deliberately keyed on `open`
  // alone: folding `busy` in here (as an earlier version did) re-ran the reset on
  // every Create click — the `finally { setBusy(false) }` toggle then wiped the
  // just-set error, so a failed create (e.g. an invalid repo URL, issue #187)
  // silently blanked the form with no message.
  useEffect(() => {
    if (open) {
      setName("");
      setSummary("");
      setDomain("");
      setGroup("");
      setStatus("active");
      setRepo("");
      setError(null);
    }
  }, [open]);

  // Escape-to-close (ignored while a create is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        status,
        group: group || undefined,
        summary: summary.trim() || undefined,
        repo: repo.trim() || undefined,
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create project");
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
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-paddock-400 hover:bg-paddock-100 hover:text-paddock-600 dark:hover:bg-paddock-800"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>

        <label className="mb-4 block">
          <span className="field-label">Name</span>
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Garage Water Heater Replacement"
          />
        </label>

        <label className="mb-4 block">
          <span className="field-label">Summary (optional)</span>
          <input
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
          </select>
        </label>

        <label className="mb-4 block">
          <span className="field-label">Git repository URL (optional)</span>
          <input
            className="input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
          />
          <span className="mt-1 block text-xs text-paddock-400 dark:text-paddock-500">
            Link an external repo and Paddock clones it as the project's working
            directory — the repo's own CLAUDE.md, branches &amp; PR flow apply. Leave
            blank for a notebook project.
          </span>
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
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </div>
  );
}
