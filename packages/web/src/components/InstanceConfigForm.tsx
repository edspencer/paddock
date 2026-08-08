import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { InstanceConfig, InstanceConfigField, InstanceConfigGroup } from "../lib/types";
import { AlertIcon, CheckIcon, SearchIcon, XIcon } from "./icons";
import { Button, Callout, Chip, Input, Section, Select, Textarea, Toggle, cx } from "./ui";

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
 *  - **Env overrides are a chip, not a paragraph.** On a containerized instance
 *    most fields are env-shadowed, and repeating the same two-line explanation
 *    beside twenty of them was the single largest source of the length. The
 *    sentence is stated once, in a legend; each field carries `env` + the var
 *    name.
 *
 * ## The structural pass (this file's second rewrite)
 *
 * That screen was right about *navigation* and wrong about *layout*, and the
 * layout is what made Ed call it "pretty terrible in either mode". Five things
 * were wrong and every one of them was geometry, not colour:
 *
 *  1. **Four unrelated left edges** stacked down the page — a full-bleed header,
 *     a rail at x=0, a filter bar flush to the right column, and a content
 *     column centred *inside* that column, so it lined up with nothing and sat
 *     optically off-centre in the window. There is ONE measure now
 *     ({@link MEASURE}), held by the filter bar, the document and the save bar
 *     alike. The save bar moved INSIDE the right column to get it: a footer that
 *     also spans the rail can never put Save on the content column's right edge,
 *     and Save belongs to the document it saves.
 *  2. **No surface at all.** `.card` is the app's container primitive and this
 *     screen used it zero times, so fields sat naked on the canvas divided by
 *     hairlines while `SettingsPane` — the other settings screen — carded every
 *     group, and the two read as different products. Both now render through the
 *     same `Section variant="card"`.
 *  3. **The two-column grid went ragged.** `sm:grid-cols-2` sizes a row by its
 *     tallest cell, and `help` here runs from zero lines to three, so nearly
 *     every row left a dead gap beside it. Fields whose height varies that much
 *     do not belong in a grid: it is one column of rows now — label and help on
 *     the left, control right-aligned in a fixed slot — so every control's right
 *     edge agrees down the whole page and no row can be ragged against another.
 *  4. **The dirty marker moved the field it marked.** `-ml-2.5 border-l-2 pl-2`
 *     shoved an edited field 10px out of its own grid track and hung the accent
 *     bar into the gutter: the one cue on the screen that actively broke the
 *     alignment. It is an absolutely-positioned bar on the card's inner edge
 *     now, so it costs no layout and an edited field sits exactly where an
 *     unedited one does.
 *  5. **Every control was a different shape** — a boxed input beside a bare
 *     monospace value beside a hand-rolled switch that existed nowhere else in
 *     the app. They all come from `components/ui` now, and a read-only value
 *     keeps an input's box metrics so locked and editable rows line up.
 *
 * Two smaller ones. The rail was `hidden lg:block`, so below 1024px the screen
 * lost the navigation its whole flat shape was justified by and handed the
 * window back the 5,500px scroll — {@link SectionScroller} carries the same
 * links horizontally at those widths. And on a containerized instance an amber
 * `env` chip plus an amber variable name, twenty times over under a permanently
 * amber banner, made the page shout; both are quiet now, because being set from
 * the environment is a *fact* about a field rather than a warning about it. The
 * banner stays amber. That one is a genuine warning.
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
 *
 * ## The editor edits the FILE, not the process (#722)
 *
 * Every control binds to `pendingValue` — what `paddock.config.yaml` says right
 * now — and not to `value`, the value the running process froze at boot. That
 * one substitution is what makes the screen honest: a save re-fetches and sees
 * its own write (it used to re-fetch the frozen boot values and look like it had
 * reverted), and a write made in another tab shows up here on the next load
 * instead of being invisible until it silently lost. Where the two disagree the
 * field says so, and the banner reports that a restart is outstanding.
 *
 * A save also carries the `configVersion` it was composed against, so a second
 * tab's stale write is refused (409) rather than quietly erasing the first.
 */

/**
 * The one measure. The filter bar, the scrolling document and the save bar all
 * hold it, so their left edges agree and — the part that was most visibly wrong
 * — the Save button's right edge lands on the content column's right edge rather
 * than the far side of the window.
 */
const MEASURE = "mx-auto w-full max-w-4xl";

/**
 * The width of a row's control slot. Fixed, so a number input, a select, a
 * switch and a read-only readout all end on the same vertical line. Below `sm`
 * there is no room for two columns and the control drops under its label.
 */
const CONTROL_SLOT = "sm:w-64";

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

  // The value shown for a field: an unsaved local edit if present, else what the
  // FILE says (`pendingValue`) — this is a file editor, so it must show the file.
  // Falling back to `f.value` matters only for a server that predates #722.
  const shownValue = (f: InstanceConfigField): unknown => baseValue(f, edits);

  const allFields = useMemo(
    () => (config ? config.groups.flatMap((g) => g.fields) : []),
    [config],
  );

  // Only editable, non-env-shadowed fields whose shown value differs from what
  // is already in the file are dirty (and thus sent on save).
  const dirtyKeys = useMemo(() => {
    return allFields
      .filter((f) => f.editable && !f.envOverridden)
      .filter((f) => Object.prototype.hasOwnProperty.call(edits, f.key))
      .filter((f) => !valuesEqual(edits[f.key], fileValue(f)))
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
        const shown = baseValue(f, edits);
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
  const dirtyByGroup = countDirty(visibleGroups, dirtySet);

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
    if (dirtyKeys.length === 0 || !config) return;
    const patch: Record<string, unknown> = {};
    for (const k of dirtyKeys) patch[k] = edits[k];
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateInstanceConfig(patch, config.configVersion);
      // The write does NOT hot-apply — re-fetch to pick up the new file contents
      // (`pendingValue`s + `configVersion`) and clear the local dirty set. Before
      // #722 this re-fetch returned the frozen BOOT values, which is why a
      // successful save looked like it had reverted.
      const fresh = await api.getInstanceConfig();
      setConfig(fresh);
      setEdits({});
      setSaved(true);
    } catch (e) {
      // 409: someone else wrote the file since this page loaded. Keep the edits
      // — they are still what the operator wants — but re-load so the form shows
      // the other writer's values and carries the new version. Saving again is
      // then a deliberate, informed overwrite of whatever still differs.
      if (e instanceof ApiError && e.status === 409) {
        try {
          setConfig(await api.getInstanceConfig());
        } catch {
          /* keep the stale snapshot; the message below is the important part */
        }
      }
      setSaveError(e instanceof Error ? e.message : String(e));
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
    <div className="flex min-h-0 flex-1">
      {config && (
        <SectionRail
          groups={visibleGroups}
          active={activeGroup}
          onJump={jumpTo}
          dirtyCount={dirtyByGroup}
        />
      )}

      {/* The document column. Filter bar, body and save bar are siblings inside
          it so all three can hold the same measure — which is the whole point. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {config && (
          <div className="border-b border-edge px-4 py-2.5 sm:px-6">
            <div className={MEASURE}>
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
              <SectionScroller
                groups={visibleGroups}
                active={activeGroup}
                onJump={jumpTo}
                dirtyCount={dirtyByGroup}
              />
            </div>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className={MEASURE}>
            <RestartBanner
              saved={saved}
              configPath={config?.configPath}
              restartRequired={config?.restartRequired ?? false}
              fileError={config?.configFileError}
            />

            {loading && <p className="text-sm text-fg-muted">Loading…</p>}
            {loadError && (
              <p className="text-sm text-danger" role="alert">
                Failed to load settings: {loadError}
              </p>
            )}

            {config && anyEnvOverridden && <EnvLegend />}

            {config && visibleCount === 0 && (
              <p className="py-8 text-center text-sm text-fg-muted">
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

            {visibleGroups.map((g) => (
              <Section
                key={g.id}
                id={sectionDomId(g.id)}
                title={g.label}
                description={g.description}
                variant="card"
                flush
                /* A top-level division of the page holding up to fourteen
                   fields, not a small titled group — so it takes the display
                   heading. At the eyebrow it sat below its own children's
                   labels in the type scale and the hierarchy read inverted. */
                heading="display"
              >
                {/* Rows, not a grid. `divide-y` reaches the card's edges because
                    the card is `flush`; a hairline that stops short of the
                    surface it divides reads as a mistake. */}
                <div className="divide-y divide-edge-subtle">
                  {g.fields.map((f) => (
                    <FieldRow
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

        {config && (
          <footer className="border-t border-edge px-4 py-3 sm:px-6">
            <div className={`${MEASURE} flex items-center gap-3`}>
              {saveError && (
                <span
                  className="flex min-w-0 items-center gap-1.5 text-sm text-danger"
                  role="alert"
                >
                  <AlertIcon width={14} height={14} className="shrink-0" />
                  <span className="truncate">{saveError}</span>
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs tabular text-fg-subtle">
                {dirtyKeys.length > 0
                  ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"}`
                  : "No changes"}
              </span>
              <Button variant="subtle" onClick={reset} disabled={dirtyKeys.length === 0 || saving}>
                Reset
              </Button>
              <Button
                variant="primary"
                onClick={save}
                disabled={dirtyKeys.length === 0}
                loading={saving}
                loadingLabel="Saving…"
              >
                Save changes
              </Button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * The left rail of section links (VS Code's table of contents, not tabs). It
 * scroll-spies rather than switching panes, so the filter above can still search
 * across every section at once.
 *
 * Below `lg` there is no room for it and {@link SectionScroller} takes over. It
 * used to simply vanish, which cost the screen the navigation that its whole
 * flat, card-less shape was justified by and handed a mid-width window straight
 * back the 5,500px scroll.
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
      className="hidden w-52 shrink-0 overflow-y-auto border-r border-edge px-2 py-4 lg:block"
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
                className={cx(
                  "motion-fast flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                  isActive
                    ? "bg-surface-selected font-medium text-fg"
                    : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                {dirty > 0 && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-solid"
                    aria-label={`${dirty} unsaved`}
                  />
                )}
                <span className="shrink-0 text-2xs tabular text-fg-subtle">{g.fields.length}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The rail's sub-`lg` form: the same links, laid horizontally and scrolled
 * sideways under the filter. A narrow window loses the *shape* of the navigation
 * now, not the navigation.
 */
function SectionScroller({
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
  if (groups.length === 0) return null;
  return (
    <nav
      aria-label="Config sections"
      className="-mx-1 mt-2 flex gap-1 overflow-x-auto px-1 pb-0.5 lg:hidden"
    >
      {groups.map((g) => {
        const isActive = g.id === active;
        const dirty = dirtyCount[g.id] ?? 0;
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onJump(g.id)}
            aria-current={isActive ? "true" : undefined}
            className={cx(
              "motion-fast flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              isActive
                ? "bg-surface-selected font-medium text-fg"
                : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            {g.label}
            {dirty > 0 && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent-solid"
                aria-label={`${dirty} unsaved`}
              />
            )}
          </button>
        );
      })}
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <SearchIcon
          width={14}
          height={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings, keys, env vars…"
          // `type=search` for the searchbox role; the UA's own clear affordance
          // is suppressed so it does not sit beside ours as a second ✕.
          className="h-8 py-0 pl-8 pr-7 [&::-webkit-search-cancel-button]:appearance-none"
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
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg"
          >
            <XIcon width={13} height={13} />
          </button>
        )}
      </div>

      <button
        type="button"
        aria-pressed={modifiedOnly}
        onClick={() => onModifiedOnly(!modifiedOnly)}
        className={cx(
          "motion-fast shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors",
          modifiedOnly
            ? "border-accent-edge bg-accent-soft text-accent"
            : "border-edge text-fg-muted hover:text-fg",
        )}
      >
        Modified only
      </button>

      <span className="shrink-0 text-xs tabular text-fg-subtle">
        {filtering ? `${visibleCount} of ${totalCount}` : `${totalCount} settings`}
      </span>
    </div>
  );
}

/**
 * The persistent restart notice. Instance config is frozen at boot, so ANY edit
 * needs a restart to take effect — the banner is always shown, switches to a
 * success tone right after a save lands, and (since #722) states plainly when
 * the file already holds changes the running process has not picked up. That
 * last state is the one that used to be unreachable: `restartRequired` was
 * hardcoded `false`, so an unapplied edit — yours or another operator's — looked
 * exactly like a clean instance.
 *
 * This is the one thing on the screen that stays loud, and it earned it:
 * everything done here is inert until someone restarts the process.
 */
function RestartBanner({
  saved,
  configPath,
  restartRequired,
  fileError,
}: {
  saved: boolean;
  configPath?: string;
  restartRequired: boolean;
  fileError?: string;
}) {
  const tone = fileError ? "danger" : saved ? "success" : "warn";
  return (
    <Callout
      tone={tone}
      className="mb-5 leading-snug"
      icon={
        tone === "success" ? (
          <CheckIcon width={15} height={15} />
        ) : (
          <AlertIcon width={15} height={15} />
        )
      }
    >
      <span role="status">
        {fileError ? (
          <>
            <strong>Could not read {filename(configPath)}.</strong> {fileError} — the values below
            are the running instance's; what a restart would load is unknown until the file parses.
          </>
        ) : saved ? (
          <>
            <strong>Saved to disk.</strong> These changes take effect only after the server
            restarts.
          </>
        ) : restartRequired ? (
          <>
            <strong>Restart pending.</strong>{" "}
            <code className="font-mono text-xs">{filename(configPath)}</code> holds changes the
            running instance has not picked up — the fields below marked{" "}
            <FieldChip tone="warn">restart</FieldChip> differ from what is in force right now.
          </>
        ) : (
          <>
            Changes here are written to{" "}
            <code className="font-mono text-xs">{filename(configPath)}</code> and take effect only
            after the server restarts — the running instance keeps its current config until then.
          </>
        )}
      </span>
    </Callout>
  );
}

/**
 * The env-override explanation, stated ONCE. Per-field it is just an `env` chip
 * plus the variable name; repeating this sentence beside twenty fields is what
 * made the old screen unreadable on a containerized instance.
 */
function EnvLegend() {
  return (
    <p className="mb-5 text-xs leading-snug text-fg-muted">
      Settings marked <FieldChip tone="neutral">env</FieldChip> are overridden by an environment
      variable, which wins over this file — edit that variable (and restart) to change them.
    </p>
  );
}

/**
 * One field, as a row rather than a grid cell.
 *
 * Two geometries, chosen by what the control IS rather than by how tall its
 * neighbour happens to be — which is precisely the bug `sm:grid-cols-2` had:
 *
 *  - **stacked** — prompts, lists and long strings put the control on its own
 *    full-width line under the label. (The old code spanned two grid columns for
 *    this. Same intent, no grid.)
 *  - **inline** — everything else: label and help left, control right-aligned in
 *    a fixed {@link CONTROL_SLOT}. Below `sm` the slot has nowhere to go and the
 *    control drops under the label — except a switch, which is small enough to
 *    hold the label line at any width.
 *
 * The dirty marker is `absolute`, so it costs no layout: an edited field sits
 * exactly where an unedited one does.
 */
function FieldRow({
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
  const helpId = f.help ? `${inputId}-help` : undefined;
  const isBoolean = f.type === "boolean";
  // Decided ONCE per field, from the SAVED value — never from `value`, which is
  // the live per-keystroke edit. The layout must not depend on the in-flight
  // edit: keying it off that made a string field flip to full width the instant
  // it crossed the length threshold, re-flowing itself and every field after it
  // and moving the caret mid-type.
  const stacked = useMemo(() => isWide(f, fileValue(f)), [f]);
  // A switch keeps the label line even on a phone; a box needs the width.
  const switchRow = isBoolean && !locked;
  // A label with nothing under it is a single line, and top-aligning it against
  // a control whose own padding pushes its text ~6px down reads as a mistake.
  // Centre those; anything with a second line still hangs from the top, which is
  // where the eye starts reading it.
  // Spelled out rather than composed — Tailwind matches class names as literal
  // source text, so an interpolated `sm:${align}` generates nothing.
  const oneLine = !f.help && !f.envOverridden && !f.pendingRestart;
  const alignSwitch = oneLine ? "items-center" : "items-start";
  const alignInline = oneLine ? "sm:items-center" : "sm:items-start";

  const control = locked ? (
    <LockedValue field={f} value={value} />
  ) : isBoolean ? (
    <Toggle id={inputId} checked={Boolean(value)} onChange={onChange} label={f.label} />
  ) : (
    <Control field={f} value={value} onChange={onChange} inputId={inputId} describedBy={helpId} />
  );

  return (
    <div className="relative px-4 py-3">
      {dirty && (
        <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent-solid" />
      )}

      <div
        className={cx(
          stacked
            ? ""
            : switchRow
              ? `flex gap-4 ${alignSwitch}`
              : `sm:flex sm:gap-6 ${alignInline}`,
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={locked ? undefined : inputId} className="text-sm font-medium text-fg">
              {f.label}
            </label>
            {f.sensitive && <FieldChip tone="warn">sensitive</FieldChip>}
            {f.envOverridden && (
              <FieldChip
                tone="neutral"
                title={`Overridden by environment variable ${f.envVar} — edit that env var (and restart) to change it.`}
              >
                env
              </FieldChip>
            )}
            {!f.editable && !f.envOverridden && <FieldChip tone="neutral">read-only</FieldChip>}
            {f.pendingRestart && (
              <FieldChip
                tone="warn"
                title="The config file and the running instance disagree on this field — restart to apply."
              >
                restart
              </FieldChip>
            )}
          </div>

          {f.help && (
            <p id={helpId} className="mt-0.5 text-xs leading-snug text-fg-muted">
              {f.help}
            </p>
          )}

          {/* WHICH variable is shadowing this field is a fact about it, not a
              warning. It used to be amber, twenty times over, under an amber
              banner, and the page read as an alarm. */}
          {f.envOverridden && (
            <p className="mt-1 truncate font-mono text-2xs text-fg-subtle">{f.envVar}</p>
          )}

          {/* The control shows the FILE. When the process disagrees, say what is
              actually in force — otherwise "restart pending" is a claim with no
              evidence, and an operator cannot tell which way round it is. */}
          {f.pendingRestart && (
            <p className="mt-1 text-2xs leading-snug text-warn">
              In force now: <span className="font-mono">{summarize(f.value)}</span>
            </p>
          )}
        </div>

        <div
          className={cx(
            stacked
              ? "mt-2"
              : switchRow
                ? "flex shrink-0 justify-end"
                : `mt-2 sm:mt-0 sm:shrink-0 ${CONTROL_SLOT}`,
          )}
        >
          {control}
        </div>
      </div>
    </div>
  );
}

/** A one-line rendering of a field value for the "in force now" note. */
function summarize(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(not set)";
  const s = Array.isArray(value) ? value.join(", ") : String(value);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * The field-label chip: the shared {@link Chip} at the one size and casing this
 * screen uses. These are metadata tags on a dense form, so they take the small
 * rung — a chip that competes with the label it annotates is most of why there
 * was so much noise here.
 */
function FieldChip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: "warn" | "neutral";
  title?: string;
}) {
  return (
    <Chip tone={tone} size="sm" title={title} className="eyebrow">
      {children}
    </Chip>
  );
}

/** The editable control for a non-boolean field. */
function Control({
  field: f,
  value,
  onChange,
  inputId,
  describedBy,
}: {
  field: InstanceConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  inputId: string;
  describedBy?: string;
}) {
  if (f.type === "enum") {
    return (
      <Select
        id={inputId}
        aria-describedby={describedBy}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {(f.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </Select>
    );
  }
  if (f.type === "number") {
    return (
      <Input
        id={inputId}
        type="number"
        aria-describedby={describedBy}
        className="tabular"
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
      <div>
        <Textarea
          id={inputId}
          aria-describedby={describedBy}
          className="min-h-[7rem] font-mono text-xs leading-relaxed"
          rows={6}
          spellCheck={false}
          value={shown}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-fg-muted">
          <span>
            {isDefaulted
              ? "Using the built-in default."
              : value === ""
                ? "Empty — nothing will be appended."
                : `${shown.length.toLocaleString()} characters.`}
          </span>
          {canRestore && (
            <Button variant="link" size="sm" className="shrink-0" onClick={() => onChange(null)}>
              Restore default
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (f.type === "string-list") {
    const asText = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return (
      <Input
        id={inputId}
        type="text"
        aria-describedby={describedBy}
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
    <Input
      id={inputId}
      type="text"
      aria-describedby={describedBy}
      value={value === null || value === undefined ? "" : String(value)}
      placeholder={f.default === null ? "" : String(f.default)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The read-only presentation of a locked (non-editable or env-shadowed) field.
 *
 * Deliberately NOT input-shaped — the old dashed box read as a disabled text
 * field, and fourteen of them in "Advanced" looked like a form you were being
 * denied rather than a list of facts. It does now keep an input's *box metrics*
 * (same radius, same padding, same slot width) with a sunken fill and no border:
 * legibly a value rather than a control, while still ending on the same vertical
 * line as the editable rows above and below it. Bare text in that slot was half
 * of what made the column look broken.
 */
function LockedValue({ field: f, value }: { field: InstanceConfigField; value: unknown }) {
  const box = "rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs text-fg-muted";
  if (f.type === "boolean") {
    return <div className={box}>{value ? "true" : "false"}</div>;
  }
  if (value === null || value === undefined || value === "") {
    // For a `text` field an empty value is a deliberate opt-out, not an absence
    // — say so rather than the generic "(not set)" (#635).
    return (
      <div className={box}>
        <span className="italic text-fg-subtle">
          {f.type === "text" && value === "" ? "(empty — nothing appended)" : "(not set)"}
        </span>
      </div>
    );
  }
  if (f.type === "text") {
    // Multi-line: preserve the operator's line breaks instead of collapsing a
    // whole prompt onto one `break-all` line.
    return (
      <div className={cx(box, "max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed")}>
        {String(value)}
      </div>
    );
  }
  return (
    <div className={cx(box, "break-all")}>
      {Array.isArray(value) ? value.join(", ") : String(value)}
    </div>
  );
}

/**
 * Which fields put their control on its own full-width line. Prompts and lists
 * always; a plain string whose value is long (a filesystem path, a URL) would
 * otherwise be truncated into uselessness in the fixed control slot.
 *
 * `saved` is deliberately the field's SAVED baseline ({@link fileValue}), not
 * the value being edited: a layout that tracks the in-flight edit re-flows under
 * the operator's caret the moment a string crosses the threshold. This is a
 * property of the field's identity — decided at load, then stable.
 */
function isWide(f: InstanceConfigField, saved: unknown): boolean {
  if (f.type === "text" || f.type === "string-list") return true;
  const s = Array.isArray(saved) ? saved.join(", ") : saved == null ? "" : String(saved);
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

/**
 * The saved baseline a field's control edits from: what the config FILE holds
 * (`pendingValue`), which is what a save overwrites and what a re-fetch reports.
 * Falls back to the effective value for a field the server did not report a
 * pending value for (a read-only or env-shadowed one, where the file cannot
 * diverge — and a pre-#722 server, which reported no pending values at all).
 */
function fileValue(f: InstanceConfigField): unknown {
  return f.pendingValue === undefined ? f.value : f.pendingValue;
}

/** The value on screen: an unsaved local edit if there is one, else the file's. */
function baseValue(f: InstanceConfigField, edits: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(edits, f.key) ? edits[f.key] : fileValue(f);
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
