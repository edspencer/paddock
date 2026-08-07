import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { InstanceConfig, InstanceConfigField, InstanceConfigGroup } from "../lib/types";
import { AlertIcon, CheckIcon, SearchIcon, XIcon } from "./icons";

/**
 * The instance-config editor BODY (issue #385) — everything below the page
 * header: the section rail, the filter bar, the fields, and the save footer.
 *
 * ## Why it is shaped like this
 *
 * There are ~47 fields in 10 groups. Rendered as one narrow column of
 * label-then-field rows it came to **5,500px — seven screenfuls** — with no way
 * to reach a known setting except scrolling past everything else, and no
 * hierarchy: `driveMode` and `webDist` had identical visual weight.
 *
 * The fix follows VS Code's settings screen rather than tabs, and the difference
 * matters: **tabs partition, which is exactly what defeats a search.** A rail of
 * section links scroll-spies over ONE document, so "jump to Branding" and "find
 * every field mentioning `token`" are both available at once and neither
 * disables the other. Concretely:
 *
 *  - **Filter bar** — matches label, dotted key, help text, env var and enum
 *    values, so an operator who thinks in `PADDOCK_*` names finds the field by
 *    typing one. A group whose LABEL matches keeps all of its fields.
 *  - **"Modified only"** — the other way in: show just what differs from the
 *    built-in default, which on a real instance is a handful of rows.
 *  - **Two-column grid.** Booleans/numbers/enums are half-width; only genuinely
 *    wide values (prompts, lists, long paths) span. This alone roughly halves
 *    the height.
 *  - **Env overrides are a chip, not a paragraph.** On a containerized instance
 *    most fields are env-shadowed, and repeating the same two-line amber
 *    explanation twenty times was the single largest source of the length. The
 *    sentence is stated once, in a legend; each field carries `env` + the var
 *    name.
 *
 * Behaviours the original ticket pins down, carried over unchanged:
 *  - **Restart-required.** Writes land in the file but never hot-apply. A
 *    persistent banner says so, and turns into a "saved — restart to apply"
 *    confirmation after a write.
 *  - **Env precedence.** A field the server reports as `envOverridden` renders
 *    read-only — editing it would silently no-op.
 *  - **Read-only bindings.** Non-editable fields (ports/paths, auth) render as
 *    plain values.
 *
 * Only dirty, editable, non-shadowed fields are sent on save.
 */
export function InstanceConfigForm() {
  const [config, setConfig] = useState<InstanceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Dirty edits keyed by field key. Absent ⇒ unchanged (shows the server value).
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Autofocus the filter on a pointer device only. `/config` is a dedicated
  // screen whose first move is nearly always "find the setting I came for", so
  // taking focus costs nothing — but doing it on a phone would throw the
  // on-screen keyboard over the page before it has been read.
  const autoFocusFilter = useMediaQuery("(min-width: 1024px)");

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
  const dirtySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys]);

  // The filtered document: groups keep their order, empty ones drop out. A group
  // whose own label matches keeps every field, so typing "branding" behaves like
  // a jump rather than hiding the section's contents.
  const visibleGroups = useMemo(() => {
    if (!config) return [];
    const q = query.trim().toLowerCase();
    const out: InstanceConfigGroup[] = [];
    for (const g of config.groups) {
      const groupHit = q !== "" && g.label.toLowerCase().includes(q);
      const fields = g.fields.filter((f) => {
        const shown = Object.prototype.hasOwnProperty.call(edits, f.key) ? edits[f.key] : f.value;
        if (modifiedOnly && valuesEqual(shown, f.default)) return false;
        if (q === "" || groupHit) return true;
        return fieldHaystack(f).includes(q);
      });
      if (fields.length > 0) out.push({ ...g, fields });
    }
    return out;
  }, [config, query, modifiedOnly, edits]);

  const visibleCount = visibleGroups.reduce((n, g) => n + g.fields.length, 0);
  const filtering = query.trim() !== "" || modifiedOnly;
  // Keyed off what is ON SCREEN: the legend explains the `env` chip, so it earns
  // its space exactly when a filtered view still contains one.
  const anyEnvOverridden = visibleGroups.some((g) => g.fields.some((f) => f.envOverridden));

  // Scroll-spy: the active rail item is the last section whose top has passed
  // the reading line. Measured against the scroll container's own box so it does
  // not care where that container sits on the page.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || visibleGroups.length === 0) return;
    const ids = visibleGroups.map((g) => g.id);
    const update = () => {
      const rootTop = root.getBoundingClientRect().top;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(sectionDomId(id));
        if (!el) continue;
        if (el.getBoundingClientRect().top - rootTop <= 80) current = id;
        else break;
      }
      setActiveGroup(current);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [visibleGroups]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(sectionDomId(id));
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    setActiveGroup(id);
  };

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
    <>
      <div className="flex min-h-0 flex-1">
        {config && (
          <SectionRail
            groups={visibleGroups}
            active={activeGroup}
            onJump={jumpTo}
            dirtyCount={countDirty(visibleGroups, dirtySet)}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {config && (
            <FilterBar
              query={query}
              onQuery={setQuery}
              modifiedOnly={modifiedOnly}
              onModifiedOnly={setModifiedOnly}
              visibleCount={visibleCount}
              totalCount={allFields.length}
              filtering={filtering}
              autoFocus={autoFocusFilter}
            />
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="mx-auto max-w-4xl">
              <RestartBanner saved={saved} configPath={config?.configPath} />

              {loading && <p className="text-sm text-paddock-500">Loading…</p>}
              {loadError && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  Failed to load settings: {loadError}
                </p>
              )}

              {config && anyEnvOverridden && <EnvLegend />}

              {config && visibleCount === 0 && (
                <p className="py-8 text-center text-sm text-paddock-500">
                  No settings match{" "}
                  {query.trim() ? (
                    <>
                      “<span className="font-medium">{query.trim()}</span>”
                    </>
                  ) : (
                    "this filter"
                  )}
                  .
                </p>
              )}

              {visibleGroups.map((g, i) => (
                <Section key={g.id} group={g} first={i === 0}>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                    {g.fields.map((f) => (
                      <Field
                        key={f.key}
                        field={f}
                        value={shownValue(f)}
                        dirty={dirtySet.has(f.key)}
                        onChange={(v) => setField(f.key, v)}
                      />
                    ))}
                  </div>
                </Section>
              ))}
            </div>
          </div>
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
    </>
  );
}

/**
 * The left rail of section links (VS Code's table of contents, not tabs). It
 * scroll-spies rather than switching panes, so the filter above can still search
 * across every section at once. Hidden below `lg`, where the filter is the only
 * practical way through anyway.
 */
function SectionRail({
  groups,
  active,
  onJump,
  dirtyCount,
}: {
  groups: InstanceConfigGroup[];
  active: string | null;
  onJump: (id: string) => void;
  dirtyCount: Record<string, number>;
}) {
  return (
    <nav
      aria-label="Config sections"
      className="hidden w-52 shrink-0 overflow-y-auto border-r border-paddock-200 px-2 py-4 dark:border-paddock-800 lg:block"
    >
      <ul className="space-y-0.5">
        {groups.map((g) => {
          const isActive = g.id === active;
          const dirty = dirtyCount[g.id] ?? 0;
          return (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => onJump(g.id)}
                aria-current={isActive ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  isActive
                    ? "bg-paddock-100 font-medium text-paddock-900 dark:bg-paddock-800 dark:text-paddock-100"
                    : "text-paddock-500 hover:bg-paddock-100/60 hover:text-paddock-800 dark:hover:bg-paddock-800/50 dark:hover:text-paddock-200"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                {dirty > 0 && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    aria-label={`${dirty} unsaved`}
                  />
                )}
                <span className="shrink-0 text-[11px] tabular-nums text-paddock-400">
                  {g.fields.length}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The filter bar: live text search plus the "modified only" lens. */
function FilterBar({
  query,
  onQuery,
  modifiedOnly,
  onModifiedOnly,
  visibleCount,
  totalCount,
  filtering,
  autoFocus,
}: {
  query: string;
  onQuery: (v: string) => void;
  modifiedOnly: boolean;
  onModifiedOnly: (v: boolean) => void;
  visibleCount: number;
  totalCount: number;
  filtering: boolean;
  autoFocus: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-paddock-200 px-4 py-2.5 dark:border-paddock-800 sm:px-6">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <SearchIcon
          width={14}
          height={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-paddock-400"
        />
        <input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings, keys, env vars…"
          // `type=search` for the searchbox role; the UA's own clear affordance
          // is suppressed so it does not sit beside ours as a second ✕.
          className="input h-8 w-full pl-8 pr-7 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
          value={query}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- gated to pointer devices; see autoFocusFilter
          autoFocus={autoFocus}
          onChange={(e) => onQuery(e.target.value)}
          // Escape empties the box rather than blurring it, so the way back to
          // the full list is the key you already reached for.
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              onQuery("");
            }
          }}
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-paddock-400 hover:text-paddock-700 dark:hover:text-paddock-200"
          >
            <XIcon width={13} height={13} />
          </button>
        )}
      </div>

      <button
        type="button"
        aria-pressed={modifiedOnly}
        onClick={() => onModifiedOnly(!modifiedOnly)}
        className={`shrink-0 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
          modifiedOnly
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-paddock-200 text-paddock-500 hover:text-paddock-800 dark:border-paddock-700 dark:hover:text-paddock-200"
        }`}
      >
        Modified only
      </button>

      <span className="shrink-0 text-[12px] tabular-nums text-paddock-400">
        {filtering ? `${visibleCount} of ${totalCount}` : `${totalCount} settings`}
      </span>
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
      className={`mb-5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] leading-snug ${
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

/**
 * The env-override explanation, stated ONCE. Per-field it is just an `env` chip
 * plus the variable name; repeating this sentence beside twenty fields is what
 * made the old screen unreadable on a containerized instance.
 */
function EnvLegend() {
  return (
    <p className="mb-5 text-[12px] leading-snug text-paddock-500">
      Settings marked <Chip tone="amber">env</Chip> are overridden by an environment variable,
      which wins over this file — edit that variable (and restart) to change them.
    </p>
  );
}

/**
 * A titled section of related fields, and the scroll-spy anchor for the rail.
 *
 * The boundary is carried by THREE cues together, because any one of them alone
 * was too weak to read as a break: a full-width rule, a big step in vertical
 * rhythm (a section is further from the one above it than its own fields are
 * from each other), and a heading a clear size/weight above a field label. The
 * first section takes no rule — there is nothing above it to divide from.
 */
function Section({
  group,
  first,
  children,
}: {
  group: InstanceConfigGroup;
  first: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={sectionDomId(group.id)}
      className={`scroll-mt-4 ${
        first ? "" : "mt-9 border-t border-paddock-200 pt-7 dark:border-paddock-800"
      }`}
    >
      <h2 className="text-base font-semibold tracking-tight text-paddock-900 dark:text-paddock-50">
        {group.label}
      </h2>
      {group.description && (
        <p className="mt-1 text-[12px] leading-snug text-paddock-500">{group.description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One field. Booleans put the control on the label line (a toggle needs no row of
 * its own); everything else stacks label → help → control. Wide types span both
 * grid columns.
 */
function Field({
  field: f,
  value,
  dirty,
  onChange,
}: {
  field: InstanceConfigField;
  value: unknown;
  dirty: boolean;
  onChange: (v: unknown) => void;
}) {
  const locked = !f.editable || f.envOverridden;
  const inputId = `cfg-${f.key}`;
  const isBoolean = f.type === "boolean";

  return (
    <div
      className={`min-w-0 ${isWide(f, value) ? "sm:col-span-2" : ""} ${
        dirty ? "-ml-2.5 border-l-2 border-accent pl-2" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={locked || isBoolean ? undefined : inputId}
          className="min-w-0 text-[13px] font-medium"
        >
          <span className="align-middle">{f.label}</span>
          {f.sensitive && <Chip tone="amber">sensitive</Chip>}
          {f.envOverridden && (
            <Chip
              tone="amber"
              title={`Overridden by environment variable ${f.envVar} — edit that env var (and restart) to change it.`}
            >
              env
            </Chip>
          )}
          {!f.editable && !f.envOverridden && <Chip tone="plain">read-only</Chip>}
        </label>
        {isBoolean && !locked && (
          <Toggle id={inputId} checked={Boolean(value)} onChange={onChange} label={f.label} />
        )}
      </div>

      {f.help && <p className="mt-0.5 text-[12px] leading-snug text-paddock-500">{f.help}</p>}

      {locked ? (
        <LockedValue field={f} value={value} />
      ) : (
        !isBoolean && <Control field={f} value={value} onChange={onChange} inputId={inputId} />
      )}

      {f.envOverridden && (
        <p className="mt-1 truncate font-mono text-[11px] text-amber-600 dark:text-amber-500/90">
          {f.envVar}
        </p>
      )}
    </div>
  );
}

/** A small inline tag beside a field label. */
function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: "amber" | "plain";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`ml-1.5 rounded px-1 py-px align-middle text-[10px] font-semibold uppercase tracking-wide ${
        tone === "amber"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
          : "bg-paddock-100 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400"
      }`}
    >
      {children}
    </span>
  );
}

/** A checkbox styled as a switch — still a real checkbox for a11y and tests. */
function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="relative shrink-0 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="block h-[18px] w-8 rounded-full bg-paddock-300 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-[14px] after:w-[14px] after:rounded-full after:bg-white after:transition-transform after:content-[''] peer-checked:bg-accent peer-checked:after:translate-x-[14px] peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 dark:bg-paddock-700" />
    </label>
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
  if (f.type === "text") {
    // A prompt-sized string (issue #635). Three states are reachable here, and
    // they are NOT the same thing:
    //   `null`  — no override in the file; Paddock's built-in default applies.
    //             Only ever a *pending* value (Restore default below); the
    //             server always reports the resolved text, never null.
    //   `""`    — an explicit empty override: append nothing, opt out.
    //   text    — that text instead of the default.
    // So a pending `null` renders as the default text (that IS what would be in
    // force), while `""` renders genuinely empty. Collapsing the two would make
    // "restore the default" look identical to "turn it off".
    // Unset OR byte-identical to the built-in: either way what's in force IS the
    // default, and saying "646 characters" instead would imply an override the
    // operator never made.
    const isDefaulted = value === null || value === undefined || value === f.default;
    const shown = value === null || value === undefined ? String(f.default ?? "") : String(value);
    const canRestore = typeof f.default === "string" && !isDefaulted;
    return (
      <div className="mt-1.5">
        <textarea
          id={inputId}
          className="input min-h-[7rem] resize-y font-mono text-[12px] leading-relaxed"
          rows={6}
          spellCheck={false}
          value={shown}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="mt-1 flex items-center justify-between gap-3 text-[12px] text-paddock-500">
          <span>
            {isDefaulted
              ? "Using the built-in default."
              : value === ""
                ? "Empty — nothing will be appended."
                : `${shown.length.toLocaleString()} characters.`}
          </span>
          {canRestore && (
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 hover:text-paddock-700 dark:hover:text-paddock-300"
              onClick={() => onChange(null)}
            >
              Restore default
            </button>
          )}
        </div>
      </div>
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

/**
 * The read-only presentation of a locked (non-editable or env-shadowed) field.
 * Deliberately NOT input-shaped — the old dashed box read as a disabled text
 * field, and fourteen of them in "Advanced" looked like a form you were being
 * denied rather than a list of facts.
 */
function LockedValue({ field: f, value }: { field: InstanceConfigField; value: unknown }) {
  return (
    <div className="mt-1 text-[12px] text-paddock-600 dark:text-paddock-300">
      {f.type === "boolean" ? (
        <span className="font-mono">{value ? "true" : "false"}</span>
      ) : value === null || value === undefined || value === "" ? (
        // For a `text` field an empty value is a deliberate opt-out, not an
        // absence — say so rather than the generic "(not set)" (#635).
        <span className="italic text-paddock-400">
          {f.type === "text" && value === "" ? "(empty — nothing appended)" : "(not set)"}
        </span>
      ) : f.type === "text" ? (
        // Multi-line: preserve the operator's line breaks instead of collapsing
        // a whole prompt onto one `break-all` line.
        <span className="block max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-paddock-50 px-2 py-1.5 font-mono text-[12px] leading-relaxed dark:bg-paddock-900/40">
          {String(value)}
        </span>
      ) : (
        <span className="block break-all font-mono">
          {Array.isArray(value) ? value.join(", ") : String(value)}
        </span>
      )}
    </div>
  );
}

/**
 * Which fields earn the full width. Prompts and lists always; a plain string
 * whose value is long (a filesystem path, a URL) would otherwise be truncated
 * into uselessness in a half-width cell.
 */
function isWide(f: InstanceConfigField, value: unknown): boolean {
  if (f.type === "text" || f.type === "string-list") return true;
  const s = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
  return s.length > 38;
}

/** Everything a search query is matched against. */
function fieldHaystack(f: InstanceConfigField): string {
  return [f.label, f.key, f.help, f.envVar, ...(f.enumValues ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Per-group count of unsaved edits, for the rail's dot. */
function countDirty(groups: InstanceConfigGroup[], dirty: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.id] = g.fields.filter((f) => dirty.has(f.key)).length;
  return out;
}

const sectionDomId = (groupId: string) => `cfg-section-${groupId}`;

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
