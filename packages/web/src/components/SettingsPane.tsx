import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type {
  CurationConfig,
  CurationOverride,
  ModelInfo,
  Project,
  ProjectLink,
  ProjectStatus,
} from "../lib/types";
import { AREAS } from "../lib/areas";
import { AlertIcon, CheckIcon, PinIcon, PlusIcon, TrashIcon } from "./icons";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done", "abandoned"];

/**
 * Build a per-project curation override (issue #384) from the three budget
 * fields. Each `""` means "inherit" and is dropped; the result is an object of
 * only the set fields, or `null` when none are set (clears the override). Field
 * order is fixed so JSON.stringify comparisons in dirty-detection are stable.
 */
function buildCurationOverride(
  overview: string,
  changelog: string,
  claude: string,
): CurationOverride | null {
  const out: CurationOverride = {};
  if (overview !== "") out.overviewMaxTokens = Number(overview);
  if (changelog !== "") out.changelogMaxTokens = Number(changelog);
  if (claude !== "") out.claudeMaxTokens = Number(claude);
  return Object.keys(out).length > 0 ? out : null;
}

/** Keeper permission modes offered here — mirrors the server's PERMISSION_MODES. */
const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only" },
  { value: "bypassPermissions", label: "Bypass all (use with care)" },
];

/**
 * Stands in for an inherited instance default before the meta fetch resolves —
 * a neutral "we don't know yet" rather than a claim about the box (#587).
 */
const LOADING_DEFAULT = "loading…";

/** A section wrapper: a titled card with an optional one-line description. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      {description && <p className="mb-3 mt-0.5 text-sm text-fg-muted">{description}</p>}
      <div className={`card ${description ? "" : "mt-2"}`}>{children}</div>
    </section>
  );
}

/** A one-line help/hint under a field. */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs leading-snug text-fg-muted">{children}</p>;
}

/** A caution note for a dangerous setting. */
function Caution({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-warn">
      <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A read-only labelled value (immutable / derived fields). */
function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg-muted">{value}</dd>
    </div>
  );
}

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
function RepoBackingSection({
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

/**
 * The project Settings tab (issue #122): the canonical place to view and edit
 * ALL per-project settings, grouped into sections with help text, replacing the
 * cramped EditProjectModal. Saves through the same `PATCH /api/projects/:slug`
 * route (which re-registers the keeper server-side).
 *
 * `driveMode` (Paddock#111) is the inherit-vs-override case: an empty override
 * inherits the box-wide global default (`PADDOCK_DRIVE_MODE`), and the UI
 * surfaces that effective value so "Global default" isn't opaque.
 */
export function SettingsPane({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (p: Project) => void;
}) {
  // Identity & metadata.
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [domain, setDomain] = useState(project.domain.join(", "));
  const [group, setGroup] = useState(project.group ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [visibility, setVisibility] = useState<"public" | "private">(project.visibility);
  const [links, setLinks] = useState<ProjectLink[]>(project.links ?? []);
  // Keeper-agent settings (issue #12 + Paddock#111).
  const [model, setModel] = useState(project.model);
  // Per-project offered-models allow-list (issue #457 Step 2). [] = inherit the
  // instance list (offer all); a non-empty subset narrows this project's picker.
  const [allowedModels, setAllowedModels] = useState<string[]>(project.models ?? []);
  const [permissionMode, setPermissionMode] = useState(project.permissionMode);
  const [maxTurns, setMaxTurns] = useState(String(project.maxTurns));
  const [docker, setDocker] = useState(project.docker);
  // "" = inherit the box-wide global default.
  const [driveMode, setDriveMode] = useState<string>(project.driveMode ?? "");
  // "" = inherit the instance default max spawn depth (issue #262).
  const [maxSpawnDepth, setMaxSpawnDepth] = useState<string>(
    project.maxSpawnDepth != null ? String(project.maxSpawnDepth) : "",
  );
  // "" = inherit the instance curation budget for that file (issue #384).
  const [overviewBudget, setOverviewBudget] = useState<string>(
    project.curation?.overviewMaxTokens != null ? String(project.curation.overviewMaxTokens) : "",
  );
  const [changelogBudget, setChangelogBudget] = useState<string>(
    project.curation?.changelogMaxTokens != null ? String(project.curation.changelogMaxTokens) : "",
  );
  const [claudeBudget, setClaudeBudget] = useState<string>(
    project.curation?.claudeMaxTokens != null ? String(project.curation.claudeMaxTokens) : "",
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  // The instance-wide defaults below are `null` until the meta fetch resolves.
  // Seeding them with a literal made the panel state instance configuration it
  // hadn't fetched yet, and drifted the moment a server default changed (#587) —
  // so the pre-fetch state is genuinely unknown and renders as such.
  // The box-wide drive-mode default a project inherits when `driveMode` is unset.
  const [driveModeDefault, setDriveModeDefault] = useState<"batch" | "session" | null>(null);
  // The instance-wide max-spawn-depth default inherited when `maxSpawnDepth` is unset.
  const [maxSpawnDepthDefault, setMaxSpawnDepthDefault] = useState<number | null>(null);
  // The instance-wide curation budgets inherited when a per-file override is unset (#384).
  const [curationDefault, setCurationDefault] = useState<CurationConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Reset the form whenever the project changes (switching projects / after save).
  useEffect(() => {
    setName(project.name);
    setSummary(project.summary);
    setDomain(project.domain.join(", "));
    setGroup(project.group ?? "");
    setStatus(project.status);
    setVisibility(project.visibility);
    setLinks(project.links ?? []);
    setModel(project.model);
    setAllowedModels(project.models ?? []);
    setPermissionMode(project.permissionMode);
    setMaxTurns(String(project.maxTurns));
    setDocker(project.docker);
    setDriveMode(project.driveMode ?? "");
    setMaxSpawnDepth(project.maxSpawnDepth != null ? String(project.maxSpawnDepth) : "");
    setOverviewBudget(
      project.curation?.overviewMaxTokens != null ? String(project.curation.overviewMaxTokens) : "",
    );
    setChangelogBudget(
      project.curation?.changelogMaxTokens != null ? String(project.curation.changelogMaxTokens) : "",
    );
    setClaudeBudget(
      project.curation?.claudeMaxTokens != null ? String(project.curation.claudeMaxTokens) : "",
    );
    setError(null);
  }, [project]);

  // Load the selectable models + the global drive-mode default.
  useEffect(() => {
    let cancelled = false;
    api
      .getModels()
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setDriveModeDefault(r.driveModeDefault);
        setMaxSpawnDepthDefault(r.maxSpawnDepthDefault);
        setCurationDefault(r.curationDefault);
      })
      .catch(() => {
        /* non-fatal: the current values are still selectable / shown */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The links the user is actually editing, with empties dropped for the patch.
  const cleanedLinks = useMemo(
    () =>
      links
        .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
        .filter((l) => l.url.length > 0),
    [links],
  );
  const cleanedDomain = useMemo(
    () =>
      domain
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    [domain],
  );

  // The patch we'd send — also the basis for dirty detection (comparing the
  // normalized current form against the project's persisted values).
  const patch = useMemo(
    () => ({
      name: name.trim(),
      status,
      group,
      summary: summary.trim(),
      domain: cleanedDomain,
      visibility,
      links: cleanedLinks,
      model,
      // "" -> [] is the "inherit the instance list" state; [] -> null CLEARS the
      // per-project override (offer all instance models). `null` (not `undefined`)
      // is required so JSON.stringify keeps the key and the server sees the reset.
      models: allowedModels.length > 0 ? allowedModels : null,
      permissionMode,
      maxTurns: Number(maxTurns),
      docker,
      // "" -> null CLEARS the per-project override (inherit the global default).
      // `null` (not `undefined`) is required: JSON.stringify drops undefined, so
      // the server would never see the key and would preserve the old override.
      driveMode: driveMode === "" ? null : (driveMode as "batch" | "session"),
      // Same tri-state as driveMode: "" -> null inherits the instance default (#262).
      maxSpawnDepth: maxSpawnDepth === "" ? null : Number(maxSpawnDepth),
      // Curation budgets (#384): each field "" -> inherit; the whole override is
      // an object of only the set fields, or `null` when none are set (clears it).
      curation: buildCurationOverride(overviewBudget, changelogBudget, claudeBudget),
    }),
    [
      name,
      status,
      group,
      summary,
      cleanedDomain,
      visibility,
      cleanedLinks,
      model,
      allowedModels,
      permissionMode,
      maxTurns,
      docker,
      driveMode,
      maxSpawnDepth,
      overviewBudget,
      changelogBudget,
      claudeBudget,
    ],
  );

  const dirty = useMemo(() => {
    const original = {
      name: project.name.trim(),
      status: project.status,
      group: project.group ?? "",
      summary: project.summary.trim(),
      domain: project.domain,
      visibility: project.visibility,
      links: (project.links ?? []).map((l) => ({ label: l.label, url: l.url })),
      model: project.model,
      // Normalize an absent override to null so it compares equal to the patch's
      // [] -> null (clean when neither has an override).
      models: project.models && project.models.length > 0 ? project.models : null,
      permissionMode: project.permissionMode,
      maxTurns: project.maxTurns,
      docker: project.docker,
      // Normalize an absent override to null so it compares equal to the
      // patch's "" -> null (clean when neither has an override).
      driveMode: project.driveMode ?? null,
      maxSpawnDepth: project.maxSpawnDepth ?? null,
      // Same normalization as the patch builder so an absent/equal override
      // compares clean (field order matches buildCurationOverride).
      curation: buildCurationOverride(
        project.curation?.overviewMaxTokens != null ? String(project.curation.overviewMaxTokens) : "",
        project.curation?.changelogMaxTokens != null ? String(project.curation.changelogMaxTokens) : "",
        project.curation?.claudeMaxTokens != null ? String(project.curation.claudeMaxTokens) : "",
      ),
    };
    return JSON.stringify(patch) !== JSON.stringify(original);
  }, [patch, project]);

  const nameInvalid = patch.name.length === 0;
  const maxTurnsNum = Number(maxTurns);
  const maxTurnsInvalid =
    !Number.isInteger(maxTurnsNum) || maxTurnsNum < 1 || maxTurnsNum > 1000;
  // "" is valid (inherit); otherwise a whole number 0–8 (MAX_SPAWN_DEPTH_LIMIT).
  const maxSpawnDepthNum = Number(maxSpawnDepth);
  const maxSpawnDepthInvalid =
    maxSpawnDepth !== "" &&
    (!Number.isInteger(maxSpawnDepthNum) || maxSpawnDepthNum < 0 || maxSpawnDepthNum > 8);

  // Each curation budget is either "" (inherit) or a positive integer (#384).
  const budgetInvalid = (v: string) =>
    v !== "" && (!Number.isInteger(Number(v)) || Number(v) < 1);
  const curationInvalid =
    budgetInvalid(overviewBudget) || budgetInvalid(changelogBudget) || budgetInvalid(claudeBudget);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameInvalid || maxTurnsInvalid || maxSpawnDepthInvalid || curationInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateProject(project.slug, patch);
      onSaved(updated);
      setSavedAt((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save changes");
    } finally {
      setBusy(false);
    }
  };

  // The box-wide default label — what "Global default" resolves to, regardless
  // of the current (possibly overriding) selection. Neutral until it's known.
  const defaultDriveLabel =
    driveModeDefault === null ? LOADING_DEFAULT : driveModeDefault === "session" ? "Session" : "Batch";

  // The models offered in the per-project default picker: the project's allow-list
  // when it narrows one (issue #457 Step 2), else the full instance list.
  const modelOptions =
    allowedModels.length > 0 ? models.filter((m) => allowedModels.includes(m.id)) : models;

  /** Toggle one model in/out of the per-project allow-list. */
  const toggleAllowedModel = (id: string, on: boolean) =>
    setAllowedModels((prev) =>
      on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id),
    );

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      {/* Sticky save bar — the single source of Save for the whole tab. */}
      <div className="flex items-center gap-3 border-b border-edge bg-surface/80 px-4 py-2.5 backdrop-blur sm:px-6">
        <span className="text-sm font-medium text-fg-muted">Settings</span>
        {dirty && !busy && <span className="text-xs text-warn">Unsaved changes</span>}
        {savedAt > 0 && !dirty && !busy && (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckIcon width={12} height={12} />
            Saved
          </span>
        )}
        <button
          type="submit"
          className="btn-primary ml-auto"
          disabled={
            busy || !dirty || nameInvalid || maxTurnsInvalid || maxSpawnDepthInvalid || curationInvalid
          }
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {error && (
            <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <Section
            title="Identity & metadata"
            description="How this project is named, grouped, and described across the app."
          >
            <label className="mb-4 block">
              <span className="field-label">Name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                aria-invalid={nameInvalid}
              />
              {nameInvalid && <Hint>Name can’t be empty.</Hint>}
            </label>

            <label className="mb-4 block">
              <span className="field-label">Summary</span>
              <input
                className="input"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="One line on what this project is about"
              />
            </label>

            <div className="mb-4 grid grid-cols-2 gap-3">
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
              <label className="block">
                <span className="field-label">Area</span>
                <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">Unsorted</option>
                  {AREAS.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.label}
                    </option>
                  ))}
                  {/* Preserve a custom/legacy area not in the canonical list. */}
                  {group && !AREAS.some((a) => a.slug === group) && (
                    <option value={group}>{group}</option>
                  )}
                </select>
              </label>
              <label className="block">
                <span className="field-label">Visibility</span>
                <select
                  className="input capitalize"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as "public" | "private")}
                >
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Domain tags</span>
                <input
                  className="input"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="home, plumbing"
                />
              </label>
            </div>

            {/* Links: labelled URLs shown on the project Home page. */}
            <div className="mb-1">
              <span className="field-label">Links</span>
              {links.length === 0 && (
                <p className="mb-2 text-xs italic text-fg-subtle">No links yet.</p>
              )}
              <div className="space-y-2">
                {links.map((l, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="input w-1/3"
                      value={l.label}
                      onChange={(e) =>
                        setLinks((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                        )
                      }
                      placeholder="Label"
                      aria-label={`Link ${i + 1} label`}
                    />
                    <input
                      className="input flex-1"
                      value={l.url}
                      onChange={(e) =>
                        setLinks((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                        )
                      }
                      placeholder="https://…"
                      aria-label={`Link ${i + 1} URL`}
                    />
                    <button
                      type="button"
                      onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove link ${i + 1}`}
                      title="Remove link"
                      className="motion-fast flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-[color,background-color,border-color,box-shadow,transform] hover:bg-danger-soft hover:text-danger"
                    >
                      <TrashIcon width={14} height={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setLinks((prev) => [...prev, { label: "", url: "" }])}
                className="btn-subtle mt-2 gap-1.5 px-2 py-1 text-xs"
              >
                <PlusIcon width={13} height={13} />
                Add link
              </button>
            </div>

            {/* Immutable / reference fields. */}
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-edge pt-4 sm:grid-cols-3">
              <ReadOnly label="Slug" value={<span className="font-mono">{project.slug}</span>} />
              <ReadOnly label="Started" value={project.started} />
            </dl>
          </Section>

          <Section
            title="Claude"
            description="How Claude runs in this workspace. Changes take effect on the next turn."
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-4">
              {/* Each field keeps its Hint/Caution as a SIBLING of the <label>
                  (not a child) so the label's accessible name stays just the
                  field name — otherwise the help text leaks into it. */}
              <div className="block">
                <label className="block">
                  <span className="field-label">Model</span>
                  <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                    {/* Keep the current model selectable even if the list hasn't
                        loaded (or it's since been removed from the picker / narrowed
                        out by the allow-list below). */}
                    {!modelOptions.some((m) => m.id === model) && (
                      <option value={model}>{model}</option>
                    )}
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Hint>Larger context windows (Opus/Fable/Sonnet: 1M; Haiku: 200K) fit longer chats.</Hint>
              </div>
              <div className="block">
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
                {permissionMode === "bypassPermissions" ? (
                  <Caution>
                    Claude runs every tool without asking — it can edit files and run commands
                    unprompted.
                  </Caution>
                ) : (
                  <Hint>How much Claude asks before acting.</Hint>
                )}
              </div>
              <div className="block">
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
                    aria-invalid={maxTurnsInvalid}
                  />
                </label>
                {maxTurnsInvalid ? (
                  <Hint>
                    <span className="text-danger">Must be a whole number 1–1000.</span>
                  </Hint>
                ) : (
                  <Hint>Upper bound on agent turns in a single run.</Hint>
                )}
              </div>
              <div className="block">
                <span className="field-label">Docker sandbox</span>
                <label className="mt-1 flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent-solid)]"
                    checked={docker}
                    onChange={(e) => setDocker(e.target.checked)}
                  />
                  <span className="text-sm text-fg-muted">Run Claude in a Docker sandbox</span>
                </label>
                {docker ? (
                  <Caution>Requires a working Docker daemon on the box, or Claude won’t start.</Caution>
                ) : (
                  <Hint>Isolate Claude's tool calls in a container.</Hint>
                )}
              </div>
              <div className="col-span-2 block">
                <span className="field-label">Offered models</span>
                {models.length === 0 ? (
                  <p className="mt-1 text-xs italic text-fg-subtle">
                    Loading the instance model list…
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                    {models.map((m) => {
                      const on = allowedModels.length === 0 || allowedModels.includes(m.id);
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 text-sm text-fg-muted"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--accent-solid)]"
                            checked={on}
                            // When inheriting (no override yet), the first UNCHECK
                            // seeds the allow-list with every OTHER model, so the box
                            // the user just cleared is the one dropped.
                            onChange={(e) => {
                              if (allowedModels.length === 0) {
                                setAllowedModels(
                                  e.target.checked ? [] : models.filter((x) => x.id !== m.id).map((x) => x.id),
                                );
                              } else {
                                toggleAllowedModel(m.id, e.target.checked);
                              }
                            }}
                            aria-label={m.label}
                          />
                          <span>{m.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {allowedModels.length === 0 ? (
                  <Hint>
                    Offering all instance models. Uncheck any to restrict this project's picker to a
                    subset; the model default above is then constrained to it.
                  </Hint>
                ) : (
                  <Hint>
                    Restricting this project's picker to {allowedModels.length} of {models.length}{" "}
                    instance models.{" "}
                    <button
                      type="button"
                      onClick={() => setAllowedModels([])}
                      className="font-medium text-accent hover:underline"
                    >
                      Offer all instance models
                    </button>
                    .
                  </Hint>
                )}
              </div>
              <div className="col-span-2 block">
                <label className="block">
                  <span className="field-label">Drive mode</span>
                  <select
                    className="input"
                    value={driveMode}
                    onChange={(e) => setDriveMode(e.target.value)}
                  >
                    <option value="">Global default ({defaultDriveLabel})</option>
                    <option value="batch">Batch (one-shot per turn)</option>
                    <option value="session">Session (cross-turn autonomy)</option>
                  </select>
                </label>
                {driveMode === "" && driveModeDefault === null ? (
                  <Hint>
                    <span className="italic text-fg-subtle">
                      Loading the box-wide drive-mode default…
                    </span>
                  </Hint>
                ) : driveMode === "" ? (
                  <Hint>
                    Inheriting the box-wide default:{" "}
                    <span className="font-medium text-fg">{defaultDriveLabel}</span>
                    . <span className="font-medium">Session</span> enables cross-turn autonomy
                    (ScheduleWakeup / <code>/loop</code>); <span className="font-medium">Batch</span>{" "}
                    is the legacy one-shot path.
                  </Hint>
                ) : (
                  <Hint>
                    Overriding the global default.{" "}
                    <button
                      type="button"
                      onClick={() => setDriveMode("")}
                      className="font-medium text-accent hover:underline"
                    >
                      Reset to global default
                    </button>
                    .
                  </Hint>
                )}
              </div>
              <div className="col-span-2 block">
                <label className="block">
                  <span className="field-label">Max spawn depth</span>
                  <select
                    className="input"
                    value={maxSpawnDepth}
                    onChange={(e) => setMaxSpawnDepth(e.target.value)}
                  >
                    <option value="">
                      Instance default ({maxSpawnDepthDefault ?? LOADING_DEFAULT})
                    </option>
                    <option value="0">0 — no spawned children get tools</option>
                    <option value="1">1 — children can report back (grandchildren can't)</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                  </select>
                </label>
                {maxSpawnDepth === "" && maxSpawnDepthDefault === null ? (
                  <Hint>
                    <span className="italic text-fg-subtle">
                      Loading the instance max-spawn-depth default…
                    </span>
                  </Hint>
                ) : maxSpawnDepth === "" ? (
                  <Hint>
                    Inheriting the instance default:{" "}
                    <span className="font-medium text-fg">{maxSpawnDepthDefault}</span>
                    . A chat spawned via <code>create_chat</code>/<code>fork_chat</code> gets the
                    self-management tools (so it can <code>send_message</code> back to its parent and
                    spawn its own) only while its depth stays within this bound.{" "}
                    <span className="font-medium">0</span> disables spawned tooling entirely.
                  </Hint>
                ) : (
                  <Hint>
                    Overriding the instance default.{" "}
                    <button
                      type="button"
                      onClick={() => setMaxSpawnDepth("")}
                      className="font-medium text-accent hover:underline"
                    >
                      Reset to instance default
                    </button>
                    .
                  </Hint>
                )}
              </div>
            </div>
          </Section>

          <Section
            title="Curation budgets"
            description="Per-file token limits the post-turn sweeper keeps this project's OVERVIEW.md, CHANGELOG.md and CLAUDE.md under. Leave a field blank to inherit the instance default."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="field-label">OVERVIEW.md (tokens)</span>
                <input
                  type="number"
                  min={1}
                  className="input"
                  placeholder={`Instance default (${curationDefault?.overviewMaxTokens ?? LOADING_DEFAULT})`}
                  value={overviewBudget}
                  onChange={(e) => setOverviewBudget(e.target.value)}
                  aria-label="OVERVIEW.md token budget"
                />
              </label>
              <label className="block">
                <span className="field-label">CHANGELOG.md (tokens)</span>
                <input
                  type="number"
                  min={1}
                  className="input"
                  placeholder={`Instance default (${curationDefault?.changelogMaxTokens ?? LOADING_DEFAULT})`}
                  value={changelogBudget}
                  onChange={(e) => setChangelogBudget(e.target.value)}
                  aria-label="CHANGELOG.md token budget"
                />
              </label>
              <label className="block">
                <span className="field-label">CLAUDE.md (tokens)</span>
                <input
                  type="number"
                  min={1}
                  className="input"
                  placeholder={`Instance default (${curationDefault?.claudeMaxTokens ?? LOADING_DEFAULT})`}
                  value={claudeBudget}
                  onChange={(e) => setClaudeBudget(e.target.value)}
                  aria-label="CLAUDE.md token budget"
                />
              </label>
            </div>
            {curationInvalid ? (
              <Hint>Each budget must be a whole number of tokens (1 or more), or blank to inherit.</Hint>
            ) : buildCurationOverride(overviewBudget, changelogBudget, claudeBudget) ? (
              <Hint>
                Overriding the instance defaults
                {curationDefault && (
                  <>
                    {" "}
                    ({curationDefault.overviewMaxTokens}/{curationDefault.changelogMaxTokens}/
                    {curationDefault.claudeMaxTokens})
                  </>
                )}{" "}
                for the fields set above.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setOverviewBudget("");
                    setChangelogBudget("");
                    setClaudeBudget("");
                  }}
                  className="font-medium text-accent hover:underline"
                >
                  Reset all to instance defaults
                </button>
                . Repo-backed projects never have their CLAUDE.md curated, so that budget is moot for
                them.
              </Hint>
            ) : curationDefault === null ? (
              <Hint>
                <span className="italic text-fg-subtle">
                  Loading the instance curation budgets…
                </span>
              </Hint>
            ) : (
              <Hint>
                Inheriting the instance defaults:{" "}
                <span className="tabular font-medium text-fg">
                  {curationDefault.overviewMaxTokens}/{curationDefault.changelogMaxTokens}/
                  {curationDefault.claudeMaxTokens}
                </span>{" "}
                tokens (OVERVIEW/CHANGELOG/CLAUDE). Lower a budget to shrink the context this project
                injects into every chat.
              </Hint>
            )}
          </Section>

          {/* Schedules moved out of Settings (Epic T / T4): they're now rows in the
              per-project Triggers tab (folded together with event hooks into the one
              unified trigger model). */}

          {/* Repository backing (issue #213): promote a notebook → repo-backed in
              place, or show the backing read-only. Its own submit (a distinct route),
              so it lives outside the settings save flow above. */}
          <RepoBackingSection project={project} onSaved={onSaved} />

          <Section
            title="Derived"
            description="Read-only state Claude and sweeps maintain."
          >
            <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2">
              <ReadOnly
                label="Overview"
                value={
                  project.hasOverview ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <CheckIcon width={12} height={12} /> OVERVIEW.md written by a sweep
                    </span>
                  ) : (
                    <span className="text-fg-subtle">No OVERVIEW.md yet</span>
                  )
                }
              />
              <ReadOnly
                label="Pinned files"
                value={
                  project.pinned.length > 0 ? (
                    <span className="flex flex-wrap gap-1.5">
                      {project.pinned.map((f) => (
                        <span
                          key={f}
                          className="inline-flex items-center gap-1 rounded-md bg-surface-active px-1.5 py-0.5 font-mono text-xs text-fg-muted"
                        >
                          <PinIcon width={11} height={11} className="text-accent" />
                          {f}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">None — pin files from the Files tab</span>
                  )
                }
              />
            </dl>
          </Section>
        </div>
      </div>
    </form>
  );
}
