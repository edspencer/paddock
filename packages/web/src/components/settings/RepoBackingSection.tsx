import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { Project } from "../../lib/types";
import { AlertIcon } from "../icons";
import { Section } from "../ui";
import { Hint, ReadOnly } from "./fields";

/**
 * Repository backing (issue #213): a NOTEBOOK project can be PROMOTED to a
 * repo-backed one IN PLACE — Paddock clones the given repo into a nested checkout,
 * flips the keeper's working directory to it (so the repo's own `CLAUDE.md`, git
 * history, branches and PR flow apply), and KEEPS the project's chats + sidecar
 * metadata (OVERVIEW/CHANGELOG/settings). Irreversible in the UI, so it's behind a
 * two-step confirm. A repo-backed project shows its backing read-only (promotion is
 * one-way; `repo` stays immutable thereafter, per #187).
 *
 * This lives OUTSIDE the main settings `<form>`'s save flow — it has its own submit
 * (a distinct server route) — hence its own local state + buttons (all `type=button`
 * so they never trigger the surrounding form's save).
 */
export function RepoBackingSection({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (p: Project) => void;
}) {
  const [repo, setRepo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form when switching projects (or after a successful promote).
  useEffect(() => {
    setRepo("");
    setConfirming(false);
    setError(null);
  }, [project.slug, project.managed]);

  // Already backed by a repo or a nominated directory: show it read-only. There
  // is no un-promote and no re-pointing (#206 — the cwd is baked into every
  // transcript path), so this is a statement of fact rather than a form.
  if (!project.managed || project.path) {
    return (
      <Section
        title="Backing"
        description={
          project.managed
            ? "Claude works in the directory below, and Paddock curates this project's notes there."
            : "Claude works in the directory below. Paddock does not write project files into it — its notes stay in the project's own folder."
        }
      >
        <dl className="grid grid-cols-1 gap-y-3">
          {project.repo && (
            <ReadOnly
              label={project.path ? "Repository (recorded)" : "Repository"}
              value={<span className="break-all font-mono text-sm">{project.repo}</span>}
            />
          )}
          <ReadOnly
            label="Working directory"
            value={<span className="break-all font-mono text-sm">{project.workingDir}</span>}
          />
        </dl>
      </Section>
    );
  }

  const trimmed = repo.trim();
  const urlInvalid = trimmed.length > 0 && !looksLikeRepoUrl(trimmed);

  const promote = async () => {
    if (!trimmed || urlInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.promoteProject(project.slug, trimmed);
      onSaved(updated);
      setConfirming(false);
      setRepo("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to promote project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Repository backing"
      description="Notebook project. Promote it to repo-backed to work directly in an external git repo — keeping all of this project's chats and notes."
    >
      <label className="block">
        <span className="field-label">Git repository URL</span>
        <input
          className="input font-mono text-sm"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            setConfirming(false);
          }}
          placeholder="https://github.com/owner/repo.git"
          aria-invalid={urlInvalid}
          aria-label="Git repository URL"
        />
        {urlInvalid ? (
          <Hint>
            <span className="text-danger">
              That doesn’t look like a git URL (https://, git@…, ssh://, git://).
            </span>
          </Hint>
        ) : (
          <Hint>
            Paddock clones this repo into a nested checkout and points Claude at it. The repo’s
            own <code>CLAUDE.md</code> and git tooling take over.
          </Hint>
        )}
      </label>

      {error && (
        <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {!confirming ? (
        <button
          type="button"
          className="btn-primary mt-4"
          disabled={busy || !trimmed || urlInvalid}
          onClick={() => setConfirming(true)}
        >
          Promote to repo-backed…
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-warn-edge bg-warn-soft p-3">
          <p className="flex items-start gap-1.5 text-sm leading-snug text-warn">
            <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
            <span>
              Promote <span className="font-semibold">{project.name}</span> to repo-backed? This
              clones <span className="break-all font-mono">{trimmed}</span>, moves Claude into
              that checkout, and stops curating this project’s <code>CLAUDE.md</code> (the repo’s own
              takes over). Your <span className="font-medium">chats and notes are kept</span>. This
              is <span className="font-medium">one-way</span>.
            </span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={promote}>
              {busy ? "Promoting…" : "Yes, promote"}
            </button>
            <button
              type="button"
              className="btn-subtle"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * A permissive client-side git-URL sanity check mirroring the server's
 * `isValidRepoUrl` (issue #187) — https(s)/git/ssh/file/absolute-path/`git@host:`.
 * Advisory only (the server re-validates); it just gates the Promote button early.
 */
function looksLikeRepoUrl(url: string): boolean {
  const u = url.trim();
  return u.length > 0 && u.length <= 512 && /^(?:https?:\/\/|git:\/\/|ssh:\/\/|file:\/\/|\/|git@[^\s]+:).+/i.test(u);
}
