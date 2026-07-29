import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project } from "../lib/types";
import { AREAS } from "../lib/areas";
import { useEscapeKey } from "../lib/useEscapeKey";
import { XIcon } from "./icons";

/**
 * Promote a chat into a NEW project (issue #20). Same fields as New Project
 * (name + area + summary + tags), prefilled with the chat's name; on confirm it
 * creates the project AND re-homes this chat's transcript into it, then hands
 * the new project back so the caller can navigate into it.
 *
 * Was scratch-only until #516 Phase 6 retired scratch. It now takes the chat's
 * CURRENT project slug — in practice the root, which is where the chats that
 * used to be one-offs now live.
 */
export function PromoteChatModal({
  open,
  slug,
  sessionId,
  defaultName,
  onClose,
  onPromoted,
}: {
  open: boolean;
  slug: string;
  sessionId: string;
  defaultName?: string;
  onClose: () => void;
  onPromoted: (project: Project, promoted: boolean) => void;
}) {
  const [name, setName] = useState(defaultName ?? "");
  const [summary, setSummary] = useState("");
  const [domain, setDomain] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form when the dialog OPENS — and only then.
  //
  // This used to share an effect with the Escape listener, which dragged `busy`
  // and `onClose` into its dependency list and made it a reset-on-anything
  // effect (#566). Two consequences, both real:
  //  - `onClose` is an inline arrow at the call site, so it is a new reference
  //    on every parent render — and `ProjectView` re-renders constantly (WS
  //    frames, chat-list refetches). Every one of those silently reverted the
  //    name the user was typing back to the chat's name.
  //  - `busy` flips true→false around the submit, so the `setError(null)` here
  //    ran immediately AFTER a failed promote and wiped the message the catch
  //    below had just set. The error could never survive to be read.
  useEffect(() => {
    if (!open) return;
    setName(defaultName ?? "");
    setSummary("");
    setDomain("");
    setGroup("");
    setError(null);
  }, [open, defaultName]);

  // Escape closes, but not out from under an in-flight promote — the request
  // would still land and create the project. Same rule as `ConfirmDialog`.
  useEscapeKey(open && !busy, onClose);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project, promoted } = await api.promoteChat(slug, sessionId, {
        name: name.trim(),
        group: group || undefined,
        summary: summary.trim() || undefined,
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      onPromoted(project, promoted);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to promote chat");
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
          <h2 className="text-lg font-semibold">Promote to project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-paddock-400 hover:bg-paddock-100 hover:text-paddock-600 dark:hover:bg-paddock-800"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>
        <p className="mb-5 text-sm text-paddock-500">
          Creates a project and moves this chat into it — its history comes along and stays
          resumable.
        </p>

        <label className="mb-4 block">
          <span className="field-label">Project name</span>
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

        <label className="mb-5 block">
          <span className="field-label">Domain tags</span>
          <input
            className="input"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="home, plumbing"
          />
        </label>

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
            {busy ? "Promoting…" : "Promote to project"}
          </button>
        </div>
      </form>
    </div>
  );
}
