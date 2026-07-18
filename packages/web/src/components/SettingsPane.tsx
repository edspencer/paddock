import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { ModelInfo, Project, ProjectLink, ProjectStatus } from "../lib/types";
import { AREAS } from "../lib/areas";
import { AlertIcon, CheckIcon, PinIcon, PlusIcon, TrashIcon } from "./icons";
import { SchedulesSection } from "./SchedulesSection";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done", "abandoned"];

/** Keeper permission modes offered here — mirrors the server's PERMISSION_MODES. */
const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only" },
  { value: "bypassPermissions", label: "Bypass all (use with care)" },
];

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
      <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">{title}</h3>
      {description && <p className="mb-3 mt-0.5 text-[13px] text-paddock-500">{description}</p>}
      <div className={`card ${description ? "" : "mt-2"}`}>{children}</div>
    </section>
  );
}

/** A one-line help/hint under a field. */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[12px] leading-snug text-paddock-500">{children}</p>;
}

/** A caution note for a dangerous setting. */
function Caution({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
      <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A read-only labelled value (immutable / derived fields). */
function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-paddock-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-paddock-700 dark:text-paddock-300">{value}</dd>
    </div>
  );
}

/**
 * The project Settings tab (issue #122): the canonical place to view and edit
 * ALL per-project settings, grouped into sections with help text, replacing the
 * cramped EditProjectModal. Saves through the same `PATCH /api/projects/:slug`
 * route (which re-registers the keeper server-side).
 *
 * `driveMode` (Paddock#111) is the inherit-vs-override case: an empty override
 * inherits the box-wide global default (`PADDOCK_KEEPER_DRIVE_MODE`), and the UI
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
  const [permissionMode, setPermissionMode] = useState(project.permissionMode);
  const [maxTurns, setMaxTurns] = useState(String(project.maxTurns));
  const [docker, setDocker] = useState(project.docker);
  // "" = inherit the box-wide global default.
  const [driveMode, setDriveMode] = useState<string>(project.driveMode ?? "");
  // "" = inherit the instance default max spawn depth (issue #262).
  const [maxSpawnDepth, setMaxSpawnDepth] = useState<string>(
    project.maxSpawnDepth != null ? String(project.maxSpawnDepth) : "",
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  // The box-wide drive-mode default a project inherits when `driveMode` is unset.
  const [driveModeDefault, setDriveModeDefault] = useState<"batch" | "session">("batch");
  // The instance-wide max-spawn-depth default inherited when `maxSpawnDepth` is unset.
  const [maxSpawnDepthDefault, setMaxSpawnDepthDefault] = useState<number>(1);
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
    setPermissionMode(project.permissionMode);
    setMaxTurns(String(project.maxTurns));
    setDocker(project.docker);
    setDriveMode(project.driveMode ?? "");
    setMaxSpawnDepth(project.maxSpawnDepth != null ? String(project.maxSpawnDepth) : "");
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
        if (r.keeperDriveModeDefault) setDriveModeDefault(r.keeperDriveModeDefault);
        if (typeof r.maxSpawnDepthDefault === "number") setMaxSpawnDepthDefault(r.maxSpawnDepthDefault);
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
      permissionMode,
      maxTurns: Number(maxTurns),
      docker,
      // "" -> null CLEARS the per-project override (inherit the global default).
      // `null` (not `undefined`) is required: JSON.stringify drops undefined, so
      // the server would never see the key and would preserve the old override.
      driveMode: driveMode === "" ? null : (driveMode as "batch" | "session"),
      // Same tri-state as driveMode: "" -> null inherits the instance default (#262).
      maxSpawnDepth: maxSpawnDepth === "" ? null : Number(maxSpawnDepth),
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
      permissionMode,
      maxTurns,
      docker,
      driveMode,
      maxSpawnDepth,
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
      permissionMode: project.permissionMode,
      maxTurns: project.maxTurns,
      docker: project.docker,
      // Normalize an absent override to null so it compares equal to the
      // patch's "" -> null (clean when neither has an override).
      driveMode: project.driveMode ?? null,
      maxSpawnDepth: project.maxSpawnDepth ?? null,
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

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameInvalid || maxTurnsInvalid || maxSpawnDepthInvalid) return;
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
  // of the current (possibly overriding) selection.
  const defaultDriveLabel = driveModeDefault === "session" ? "Session" : "Batch";

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      {/* Sticky save bar — the single source of Save for the whole tab. */}
      <div className="flex items-center gap-3 border-b border-paddock-200 bg-canvas/80 px-4 py-2.5 backdrop-blur dark:border-paddock-800 dark:bg-paddock-900/60 sm:px-6">
        <span className="text-sm font-medium text-paddock-700 dark:text-paddock-200">Settings</span>
        {dirty && !busy && (
          <span className="text-[12px] text-amber-600 dark:text-amber-400">Unsaved changes</span>
        )}
        {savedAt > 0 && !dirty && !busy && (
          <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
            <CheckIcon width={12} height={12} />
            Saved
          </span>
        )}
        <button
          type="submit"
          className="btn-primary ml-auto"
          disabled={busy || !dirty || nameInvalid || maxTurnsInvalid || maxSpawnDepthInvalid}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {error && (
            <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
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
                <p className="mb-2 text-[12px] italic text-paddock-400">No links yet.</p>
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
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paddock-400 transition hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
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
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-paddock-200 pt-4 sm:grid-cols-3 dark:border-paddock-800">
              <ReadOnly label="Slug" value={<span className="font-mono">{project.slug}</span>} />
              <ReadOnly label="Started" value={project.started} />
              <ReadOnly label="Created" value={project.created} />
            </dl>
          </Section>

          <Section
            title="Keeper agent"
            description="How this project's keeper agent runs. Changes re-register the keeper."
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
                        loaded (or it's since been removed from the picker). */}
                    {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                    {models.map((m) => (
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
                    The keeper runs every tool without asking — it can edit files and run commands
                    unprompted.
                  </Caution>
                ) : (
                  <Hint>How much the keeper asks before acting.</Hint>
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
                    <span className="text-rose-600 dark:text-rose-400">Must be a whole number 1–1000.</span>
                  </Hint>
                ) : (
                  <Hint>Upper bound on agent turns in a single keeper run.</Hint>
                )}
              </div>
              <div className="block">
                <span className="field-label">Docker sandbox</span>
                <label className="mt-1 flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={docker}
                    onChange={(e) => setDocker(e.target.checked)}
                  />
                  <span className="text-sm text-paddock-700 dark:text-paddock-200">
                    Run the keeper in a Docker sandbox
                  </span>
                </label>
                {docker ? (
                  <Caution>Requires a working Docker daemon on the box, or the keeper won’t start.</Caution>
                ) : (
                  <Hint>Isolate the keeper's tool calls in a container.</Hint>
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
                {driveMode === "" ? (
                  <Hint>
                    Inheriting the box-wide default:{" "}
                    <span className="font-medium text-paddock-700 dark:text-paddock-200">
                      {defaultDriveLabel}
                    </span>
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
                    <option value="">Instance default ({maxSpawnDepthDefault})</option>
                    <option value="0">0 — no spawned children get tools</option>
                    <option value="1">1 — children can report back (grandchildren can't)</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                  </select>
                </label>
                {maxSpawnDepth === "" ? (
                  <Hint>
                    Inheriting the instance default:{" "}
                    <span className="font-medium text-paddock-700 dark:text-paddock-200">
                      {maxSpawnDepthDefault}
                    </span>
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

          {/* Scheduled chats for this project (issue #266 / D4). Self-contained:
              its create/edit/delete/enable/trigger run through their own
              endpoints, so it's outside the Settings save bar's dirty/save flow. */}
          <SchedulesSection project={project} />

          <Section
            title="Derived"
            description="Read-only state the keeper and sweeps maintain."
          >
            <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2">
              <ReadOnly
                label="Overview"
                value={
                  project.hasOverview ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckIcon width={12} height={12} /> OVERVIEW.md written by a sweep
                    </span>
                  ) : (
                    <span className="text-paddock-400">No OVERVIEW.md yet</span>
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
                          className="inline-flex items-center gap-1 rounded-md bg-paddock-100 px-1.5 py-0.5 font-mono text-[12px] text-paddock-700 dark:bg-paddock-900 dark:text-paddock-300"
                        >
                          <PinIcon width={11} height={11} className="text-accent" />
                          {f}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-paddock-400">None — pin files from the Files tab</span>
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
