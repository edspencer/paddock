import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { ShellOutletContext } from "../components/AppShell";
import type { InstanceConfig, InstanceConfigField } from "../lib/types";
import { AlertIcon, CheckIcon, CogIcon, MenuIcon } from "../components/icons";

/**
 * Instance-wide Settings screen (issue #385) — a top-level admin surface over
 * the frozen instance config (`paddock.config.yaml`), distinct from the
 * per-project Settings tab.
 *
 * Three behaviours the ticket pins down are reflected in the UI:
 *  - **Restart-required.** Instance config is read once at boot + frozen; writes
 *    land in the file but never hot-apply. A persistent banner says so, and it
 *    turns into a "saved — restart to apply" confirmation after a write.
 *  - **Env precedence.** A field the server reports as `envOverridden` is
 *    rendered read-only with an "overridden by <ENV>" note — editing it would
 *    silently no-op.
 *  - **Read-only bindings.** Non-editable fields (ports/paths, auth) render as
 *    plain values.
 *
 * Only dirty, editable, non-shadowed fields are sent on save.
 */
export function InstanceSettings() {
  const shell = useOutletContext<ShellOutletContext | null>();
  const openNav = shell?.openNav ?? (() => {});

  const [config, setConfig] = useState<InstanceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Dirty edits keyed by field key. Absent ⇒ unchanged (shows the server value).
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getInstanceConfig()
      .then((c) => {
        if (!live) return;
        setConfig(c);
        setLoadError(null);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const setField = (key: string, value: unknown) => {
    setSaved(false);
    setSaveError(null);
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  // The value shown for a field: a pending edit if present, else the server's.
  const shownValue = (f: InstanceConfigField): unknown =>
    Object.prototype.hasOwnProperty.call(edits, f.key) ? edits[f.key] : f.value;

  const allFields = useMemo(
    () => (config ? config.groups.flatMap((g) => g.fields) : []),
    [config],
  );

  // Only editable, non-env-shadowed fields whose shown value differs from the
  // server's are dirty (and thus sent on save).
  const dirtyKeys = useMemo(() => {
    return allFields
      .filter((f) => f.editable && !f.envOverridden)
      .filter((f) => Object.prototype.hasOwnProperty.call(edits, f.key))
      .filter((f) => !valuesEqual(edits[f.key], f.value))
      .map((f) => f.key);
  }, [allFields, edits]);

  const save = async () => {
    if (dirtyKeys.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const k of dirtyKeys) patch[k] = edits[k];
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateInstanceConfig(patch);
      // The write does NOT hot-apply — re-fetch to confirm the (still-frozen)
      // values and clear the local dirty set. The restart banner does the rest.
      const fresh = await api.getInstanceConfig();
      setConfig(fresh);
      setEdits({});
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setEdits({});
    setSaveError(null);
    setSaved(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex items-center gap-2 border-b border-paddock-200 px-3 pb-2.5 dark:border-paddock-800 sm:px-6 lg:py-4">
        <button
          type="button"
          onClick={openNav}
          aria-label="Open menu"
          className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
        >
          <MenuIcon width={20} height={20} />
        </button>
        <CogIcon width={18} height={18} className="shrink-0 text-paddock-400" />
        <h1 className="text-[15px] font-semibold tracking-tight">Instance settings</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-2xl">
          <RestartBanner saved={saved} configPath={config?.configPath} />

          {loading && <p className="text-sm text-paddock-500">Loading…</p>}
          {loadError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              Failed to load settings: {loadError}
            </p>
          )}

          {config &&
            config.groups.map((g) => (
              <Section key={g.id} title={g.label} description={g.description}>
                <div className="grid grid-cols-1 gap-4">
                  {g.fields.map((f) => (
                    <Field
                      key={f.key}
                      field={f}
                      value={shownValue(f)}
                      onChange={(v) => setField(f.key, v)}
                    />
                  ))}
                </div>
              </Section>
            ))}
        </div>
      </div>

      {config && (
        <footer className="flex items-center gap-3 border-t border-paddock-200 px-4 py-3 dark:border-paddock-800 sm:px-6">
          {saveError && (
            <span className="flex items-center gap-1.5 text-[13px] text-red-600 dark:text-red-400" role="alert">
              <AlertIcon width={14} height={14} className="shrink-0" />
              {saveError}
            </span>
          )}
          <span className="ml-auto text-[12px] text-paddock-400">
            {dirtyKeys.length > 0
              ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"}`
              : "No changes"}
          </span>
          <button
            type="button"
            className="btn-subtle"
            onClick={reset}
            disabled={dirtyKeys.length === 0 || saving}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={dirtyKeys.length === 0 || saving}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </footer>
      )}
    </div>
  );
}

/**
 * The persistent restart notice. Instance config is frozen at boot, so ANY edit
 * needs a restart to take effect — the banner is always shown, and switches to a
 * success tone right after a save lands.
 */
function RestartBanner({ saved, configPath }: { saved: boolean; configPath?: string }) {
  return (
    <div
      role="status"
      className={`mb-6 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] leading-snug ${
        saved
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-900/20 dark:text-emerald-300"
          : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300"
      }`}
    >
      {saved ? (
        <CheckIcon width={15} height={15} className="mt-0.5 shrink-0" />
      ) : (
        <AlertIcon width={15} height={15} className="mt-0.5 shrink-0" />
      )}
      <span>
        {saved ? (
          <>
            <strong>Saved to disk.</strong> These changes take effect only after the server
            restarts.
          </>
        ) : (
          <>
            Changes here are written to <code className="font-mono text-[12px]">{filename(configPath)}</code>{" "}
            and take effect only after the server restarts — the running instance keeps its current
            config until then.
          </>
        )}
      </span>
    </div>
  );
}

/** A titled card grouping related fields. */
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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">{title}</h2>
      {description && <p className="mb-3 mt-0.5 text-[13px] text-paddock-500">{description}</p>}
      <div className={`card ${description ? "" : "mt-2"}`}>{children}</div>
    </section>
  );
}

/** One field row: a label + control (or read-only value) + hints/notes. */
function Field({
  field: f,
  value,
  onChange,
}: {
  field: InstanceConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const locked = !f.editable || f.envOverridden;
  const inputId = `cfg-${f.key}`;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={locked ? undefined : inputId} className="text-sm font-medium">
          {f.label}
          {f.sensitive && (
            <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              sensitive
            </span>
          )}
        </label>
        {f.type === "boolean" && !locked && (
          <input
            id={inputId}
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
        )}
      </div>

      {f.help && <p className="mt-0.5 text-[12px] leading-snug text-paddock-500">{f.help}</p>}

      {locked ? (
        <LockedValue field={f} value={value} />
      ) : (
        f.type !== "boolean" && <Control field={f} value={value} onChange={onChange} inputId={inputId} />
      )}

      {f.envOverridden && (
        <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
          <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
          <span>
            Overridden by environment variable <code className="font-mono">{f.envVar}</code> — edit
            that env var (and restart) to change it.
          </span>
        </p>
      )}
    </div>
  );
}

/** The editable control for a non-boolean field. */
function Control({
  field: f,
  value,
  onChange,
  inputId,
}: {
  field: InstanceConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  inputId: string;
}) {
  if (f.type === "enum") {
    return (
      <select
        id={inputId}
        className="input mt-1.5"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {(f.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === "number") {
    return (
      <input
        id={inputId}
        type="number"
        className="input mt-1.5"
        value={value === null || value === undefined ? "" : String(value)}
        placeholder={f.default === null ? "default" : String(f.default)}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  }
  if (f.type === "string-list") {
    const asText = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return (
      <input
        id={inputId}
        type="text"
        className="input mt-1.5"
        value={asText}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  // string
  return (
    <input
      id={inputId}
      type="text"
      className="input mt-1.5"
      value={value === null || value === undefined ? "" : String(value)}
      placeholder={f.default === null ? "" : String(f.default)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The read-only presentation of a locked (non-editable or env-shadowed) field. */
function LockedValue({ field: f, value }: { field: InstanceConfigField; value: unknown }) {
  return (
    <div className="mt-1.5 rounded-md border border-dashed border-paddock-300 bg-paddock-50 px-2.5 py-1.5 text-[13px] text-paddock-600 dark:border-paddock-700 dark:bg-paddock-900/40 dark:text-paddock-300">
      {f.type === "boolean" ? (
        <span className="font-mono">{value ? "true" : "false"}</span>
      ) : value === null || value === undefined || value === "" ? (
        <span className="italic text-paddock-400">(not set)</span>
      ) : (
        <span className="break-all font-mono">
          {Array.isArray(value) ? value.join(", ") : String(value)}
        </span>
      )}
    </div>
  );
}

/** Compare two field values (arrays by content) for dirty-detection. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** The basename of the config path, for the banner (falls back to the full string). */
function filename(p?: string): string {
  if (!p) return "paddock.config.yaml";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
