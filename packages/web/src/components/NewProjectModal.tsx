import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project } from "../lib/types";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        summary: summary.trim() || undefined,
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      onCreated(project);
      setName("");
      setSummary("");
      setDomain("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-xl border border-paddock-200 bg-white p-5 shadow-xl dark:border-paddock-800 dark:bg-paddock-900"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="mb-4 text-lg font-semibold">New project</h2>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-paddock-600 dark:text-paddock-300">Name</span>
          <input
            autoFocus
            className="w-full rounded-lg border border-paddock-300 bg-paddock-50 px-3 py-2 outline-none focus:border-paddock-500 dark:border-paddock-700 dark:bg-paddock-950"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Garage Water Heater Replacement"
          />
        </label>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-paddock-600 dark:text-paddock-300">Summary</span>
          <input
            className="w-full rounded-lg border border-paddock-300 bg-paddock-50 px-3 py-2 outline-none focus:border-paddock-500 dark:border-paddock-700 dark:bg-paddock-950"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One-line description"
          />
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-paddock-600 dark:text-paddock-300">
            Domain tags (comma-separated)
          </span>
          <input
            className="w-full rounded-lg border border-paddock-300 bg-paddock-50 px-3 py-2 outline-none focus:border-paddock-500 dark:border-paddock-700 dark:bg-paddock-950"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="home, plumbing"
          />
        </label>

        {error && <p className="mb-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
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
