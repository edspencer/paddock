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
  const [linkPath, setLinkPath] = useState("");
  // Only meaningful when a path is given with no repo — see the checkbox below.
  const [managedNotes, setManagedNotes] = useState(false);
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
      setLinkPath("");
      setManagedNotes(false);
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
        path: linkPath.trim() || undefined,
        // Send `managed` only for the ambiguous shape (a path with no repo);
        // otherwise let the server derive it, so there is one rule not two.
        managed:
          linkPath.trim() && !repo.trim() ? managedNotes : undefined,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <form
        className="w-full max-w-md animate-scale-in rounded-2xl border border-edge bg-surface-raised p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-muted"
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
          <span className="field-label">Directory on this machine (optional)</span>
          <input
            className="input"
            value={linkPath}
            onChange={(e) => setLinkPath(e.target.value)}
            placeholder="/home/ed/Code/foo"
          />
          <span className="mt-1 block text-xs text-fg-subtle">
            Where this project's content lives. An existing checkout is used in
            place — its real history, branches and remotes — and Paddock writes
            nothing into it. Absolute path; created for you if it doesn't exist.
          </span>
        </label>

        <label className="mb-4 block">
          <span className="field-label">Git repository URL (optional)</span>
          <input
            className="input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
          />
          <span className="mt-1 block text-xs text-fg-subtle">
            {!linkPath.trim()
              ? "Paddock clones this repo into the project and works in the checkout. Leave both blank for a notes project."
              : "Cloned into the directory above if it doesn't exist yet; otherwise the directory is used as-is and this just records which repo it is."}
          </span>
        </label>

        {/*
          `managed` is derived server-side as `!(repo || path)`, which decides the
          two unambiguous cases on its own: naming a repo means code, naming
          neither means notes. A path ALONE is the one genuinely ambiguous input —
          `~/Code/foo` could be a checkout or a folder of notes — so that is the
          only time the choice is worth putting to the user.
        */}
        {linkPath.trim() && !repo.trim() && (
          <label className="mb-4 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={managedNotes}
              onChange={(e) => setManagedNotes(e.target.checked)}
            />
            <span className="text-xs text-fg-muted">
              <span className="font-medium">These are notes — let Paddock curate them.</span>{" "}
              Its OVERVIEW.md, CHANGELOG.md and CLAUDE.md are written into that
              directory. Leave unticked for a code checkout you version yourself,
              and Paddock will write nothing into it.
            </span>
          </label>
        )}

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
          <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
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
