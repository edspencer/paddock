/**
 * The appearance picker: theme, accent colour, ground tint.
 *
 * ── The one hard constraint on this file ─────────────────────────────────────
 * It must never expose colour theory. No "hue", no "chroma", no "lightness",
 * no "OKLCH", no required hex entry. You pick a colour the way a person picks a
 * colour — off a strip, or by name — and it works. Every number in here is
 * either a preview you look at or a diagnostic clearly marked as one.
 *
 * That is not a stylistic preference; it is the feature. The maths exists so
 * that the interface can be this small. If a user has to understand anything to
 * use this, the solver has failed no matter how correct it is.
 *
 * ── Where it lives ───────────────────────────────────────────────────────────
 * A section at the top of `/config`, which is where every other setting lives.
 * An earlier cut put it in a `Dialog` and then in a floating dock; both were
 * answers to the same mistake, which was covering the app you are recolouring.
 * The config page solves it outright: the picker previews itself against a
 * real, token-dense screen, and the page's width lets the whole control be one
 * ~370px band instead of a tall column.
 *
 * It is NOT one of that page's config fields — see `APPEARANCE_GROUP` in
 * InstanceConfigForm for why that distinction is kept visible.
 *
 * ── What is real ─────────────────────────────────────────────────────────────
 * Every swatch on the strip is painted with the colour that position actually
 * produces — `accentSwatches()` runs the same solve the app will run. The
 * theme cards are real scraps of their theme, cascaded by the same
 * `[data-theme]` blocks the app uses, not hand-picked preview hexes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { accentSwatches, applyAccent, clearAccent, type AccentReport } from "../lib/accent";
import {
  APPEARANCE_EVENT,
  NAMED_HUES,
  THEMES,
  TINTS,
  readAppearance,
  saveAppearance,
  type Appearance,
  type ThemeId,
} from "../lib/appearance";
import { Button, Chip, StatusDot, cx } from "./ui";

/** Hues to paint the strip at. 5-degree steps: finer than the eye separates at
 *  this width, coarse enough that the whole strip is one cheap solve. */
const STRIP = Array.from({ length: 72 }, (_, i) => i * 5);

/** The nearest named colour to a hue, for the "you picked…" label. Purely a
 *  label — an unnamed hue is still perfectly valid, it just reads as "Custom". */
function nearestName(hue: number): string {
  let best: { name: string; hue: number } = NAMED_HUES[0];
  let bestD = 360;
  for (const n of NAMED_HUES) {
    const d = Math.min(Math.abs(n.hue - hue), 360 - Math.abs(n.hue - hue));
    if (d < bestD) [best, bestD] = [n, d];
  }
  return bestD <= 6 ? best.name : "Custom";
}

/**
 * A live scrap of a theme: its canvas, a card on it, its accent button, and two
 * bars of body text. Small enough to scan five of at once, complete enough that
 * the choice is informed — the ground/card relationship and the accent are the
 * three things that actually differ between these directions.
 *
 * `data-theme` + `dark` go on this element rather than on `<html>`, which the
 * generated blocks support on purpose (they are not `html`-prefixed).
 */
function ThemeSwatch({
  theme,
  dark,
  hue,
  className,
}: {
  theme: ThemeId;
  dark: boolean;
  /** The picked hue, or null to show the theme's own accent. */
  hue: number | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  /**
   * Solve the picked colour for THIS theme, on this element.
   *
   * `applyAccent` takes any element, not just `<html>`, and reads its computed
   * tokens — so pointing it at a preview gives that preview the same solve the
   * app would run if you switched to it. Five previews at one hue therefore
   * show five genuinely different accents, because each theme contributes its
   * own chroma and its own contrast targets. Showing every preview the theme's
   * shipped accent while the app wears a different one would be the picker
   * lying about the thing it exists to preview.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (hue === null) clearAccent(el);
    else applyAccent(hue, el);
  }, [theme, dark, hue]);

  return (
    <div
      ref={ref}
      data-theme={theme}
      className={cx("overflow-hidden rounded-lg border border-edge", dark && "dark", className)}
    >
      <div className="flex h-full items-center gap-2 bg-surface p-2">
        <div className="flex-1 rounded-md border border-edge-subtle bg-surface-raised p-1.5">
          <div className="h-1 w-4/5 rounded-full bg-fg" />
          <div className="mt-1 h-1 w-3/5 rounded-full bg-fg-subtle" />
        </div>
        <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-solid">
          <div className="h-1 w-3 rounded-full bg-accent-fg" />
        </div>
      </div>
    </div>
  );
}

export interface AppearancePanelProps {
  /**
   * `"narrow"` is the docked panel: one column, themes as rows.
   * `"wide"` is the section on `/config`: themes across, strip full-bleed. The
   * same controls either way — only the shelf they sit on differs.
   */
  variant?: "wide" | "narrow";
  className?: string;
}

export function AppearancePanel({ variant = "wide", className }: AppearancePanelProps) {
  const compact = variant === "narrow";
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [report, setReport] = useState<AccentReport | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  /**
   * Apply a partial change.
   *
   * The current appearance is held in a ref as well as in state because two
   * changes inside one task — pick a theme, then pick a colour — would both
   * read the same pre-render `appearance` object, and the second would silently
   * revert the first. React has not re-rendered in between; the ref has.
   */
  const current = useRef(appearance);
  const commit = useCallback((patch: Partial<Appearance>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setAppearance(next);
    setReport(saveAppearance(next));
  }, []);

  // The solve itself runs at boot and on every light/dark flip (see
  // `initAppearance`); this only listens, so the readout and the strip follow a
  // mode change made from the button next door.
  useEffect(() => {
    const onApplied = (e: Event) => setReport((e as CustomEvent<AccentReport | null>).detail);
    window.addEventListener(APPEARANCE_EVENT, onApplied);
    setReport(saveAppearance(readAppearance()));
    return () => window.removeEventListener(APPEARANCE_EVENT, onApplied);
  }, []);

  // The strip is re-solved per theme and per mode — the same hue is a different
  // colour on a dark canvas, and the strip should show that rather than lie.
  const strip = useMemo(
    () => accentSwatches(STRIP),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-solve when the
    // rendered theme or mode changes; `report` is the signal that it did.
    [appearance.theme, dark, report?.mode],
  );

  const activeHue = report?.hue ?? 0;
  const isCustom = appearance.hue !== null;

  return (
    <div className={cx("space-y-5", className)}>
      {/* ------------------------------------------------------------ theme -- */}
      <fieldset>
        <legend className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">
          Theme
        </legend>
        {/* Narrow: rows, swatch beside name. Wide: five across, swatch on top.
            Both are the same five buttons — the layout is the only difference,
            and it is what keeps the section short on a page and the dock short
            in a column. */}
        <div
          className={cx(
            "mt-2 grid gap-1.5",
            compact ? "grid-cols-1" : "gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
          )}
        >
          {THEMES.map((t) => {
            const selected = appearance.theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                onClick={() => commit({ theme: t.id })}
                className={cx(
                  "motion-fast rounded-xl border text-left transition-[border-color,box-shadow]",
                  "focus-visible:focus-ring",
                  compact ? "flex items-center gap-2.5 p-1.5" : "p-1.5",
                  selected
                    ? "border-accent-edge bg-accent-soft shadow-xs"
                    : "border-edge bg-surface-raised hover:border-edge-strong",
                )}
              >
                <ThemeSwatch
                  theme={t.id}
                  dark={dark}
                  hue={appearance.hue}
                  className={compact ? "h-9 w-20 shrink-0" : "h-10"}
                />
                <div className={cx("min-w-0", compact ? "" : "mt-1.5 px-0.5 pb-0.5")}>
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-semibold text-fg">{t.label}</span>
                    {selected && <span className="shrink-0 text-3xs text-accent">in use</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Wide, the colour strip and the tint sit side by side rather than
          stacked: the strip wants length and the tint wants almost none, so
          stacking them is what makes a short section tall for no reason. */}
      <div
        className={cx(
          compact ? "space-y-5" : "grid gap-5 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start",
        )}
      >
        {/* --------------------------------------------------------- colour -- */}
        <fieldset>
          <legend className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">
            Accent colour
          </legend>
          <p className="mt-1 text-3xs leading-snug text-fg-subtle">
            Pick any colour. The theme adjusts it so buttons and labels stay readable in both light
            and dark.
          </p>

          {/* The strip. Each cell is the real solved colour at that position, so
              what you see is what the primary button becomes. */}
          <div
            role="group"
            aria-label="Accent colour spectrum"
            className="mt-2 flex h-8 overflow-hidden rounded-lg border border-edge shadow-xs"
          >
            {strip.map((hex, i) => {
              const hue = STRIP[i];
              const active = isCustom && Math.abs(activeHue - hue) < 2.5;
              return (
                <button
                  key={hue}
                  type="button"
                  title={nearestName(hue) === "Custom" ? "This colour" : nearestName(hue)}
                  aria-label={`Accent colour ${i + 1} of ${strip.length}`}
                  onClick={() => commit({ hue })}
                  style={{ backgroundColor: hex }}
                  className={cx(
                    "h-full flex-1 focus-visible:relative focus-visible:z-10 focus-visible:focus-ring",
                    active && "relative z-10 ring-2 ring-fg ring-inset",
                  )}
                />
              );
            })}
          </div>

          {/* …and the same thing by name, because most of the time you know
              which colour you want and do not want to hunt for it. */}
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => commit({ hue: null })}
              aria-pressed={!isCustom}
              className={cx(
                "motion-fast rounded-md border px-2 py-1 text-3xs transition-colors",
                "focus-visible:focus-ring",
                !isCustom
                  ? "border-accent-edge bg-accent-soft text-accent"
                  : "border-edge text-fg-muted hover:border-edge-strong hover:text-fg",
              )}
            >
              Theme’s own
            </button>
            {NAMED_HUES.map((n) => {
              const active = isCustom && Math.abs(activeHue - n.hue) < 2.5;
              return (
                <button
                  key={n.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => commit({ hue: n.hue })}
                  className={cx(
                    "motion-fast inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-3xs transition-colors",
                    "focus-visible:focus-ring",
                    active
                      ? "border-edge-strong bg-surface-active text-fg"
                      : "border-edge text-fg-muted hover:border-edge-strong hover:text-fg",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: strip[Math.round(n.hue / 5) % strip.length] }}
                  />
                  {n.name}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* ----------------------------------------------------------- tint -- */}
        <fieldset>
          <legend className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">
            Tint the background
          </legend>
          <p className="mt-1 text-3xs leading-snug text-fg-subtle">
            Colours the whole page a little, not just the buttons. Useful for telling two Paddock
            instances apart at a glance.
          </p>
          <div className="mt-2 inline-flex rounded-lg border border-edge p-0.5">
            {TINTS.map((t) => (
              <button
                key={t.level}
                type="button"
                aria-pressed={appearance.tint === t.level}
                onClick={() => commit({ tint: t.level })}
                className={cx(
                  "motion-fast rounded-md px-2.5 py-1 text-3xs transition-colors",
                  "focus-visible:focus-ring",
                  appearance.tint === t.level
                    ? "bg-surface-active font-medium text-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
            </div>
        </fieldset>
      </div>

      {/* ---------------------------------------------------------- preview -- */}
      <AccentPreview />

      {/* ---------------------------------------------------------- readout -- */}
      {report && <ContrastReadout report={report} open={showChecks} onToggle={setShowChecks} />}
    </div>
  );
}

/**
 * The accent, on the actual controls that wear it.
 *
 * This exists because of a mistake worth recording. The picker moved onto
 * `/config` to stop it covering the app — and `/config` turns out to paint only
 * **seven** elements with `--accent-solid`, the largest of which is the Save
 * button, which is disabled and therefore muted whenever the form is clean. So
 * changing the accent was genuinely, correctly applying and genuinely looking
 * like nothing had happened. A control you cannot see the effect of is broken
 * however correct its output.
 *
 * These are the real primitives (`Button`, `Chip`, `StatusDot`) with the real
 * tokens, not a painted mock — which is the point: if the accent breaks a
 * button, it breaks here too. The hover fill is shown as a plain swatch rather
 * than a button, because you cannot force `:hover` and the hover step is
 * exactly where the contrast inversion lived.
 */
function AccentPreview() {
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">Preview</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface p-3">
        <Button variant="primary" size="sm">
          Send
        </Button>
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button variant="link" size="sm">
          A link
        </Button>
        <span className="inline-flex items-center gap-1 rounded-md border border-accent-edge bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
          accent chip
        </span>
        <Chip tone="accent" shape="pill" dot>
          running
        </Chip>
        <span className="inline-flex items-center gap-1.5 text-2xs text-fg-subtle">
          <span
            className="h-4 w-4 rounded-md border border-edge bg-accent-solid-hover"
            aria-hidden
          />
          hovered
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <StatusDot tone="success" />
          <StatusDot tone="warn" />
          <StatusDot tone="danger" />
          <StatusDot tone="info" />
          <span className="text-2xs text-fg-subtle">status hues (theme’s, not yours)</span>
        </span>
      </div>
    </div>
  );
}

/**
 * The diagnostic. This is for whoever is reviewing the solver, not for whoever
 * is picking a colour — hence the deliberately technical framing and the fact
 * that it is collapsed by default. The headline is the only part a normal user
 * should ever need, and even that is really just reassurance.
 */
function ContrastReadout({
  report,
  open,
  onToggle,
}: {
  report: AccentReport;
  open: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2.5 py-2">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:focus-ring"
      >
        <span className="text-3xs text-fg-muted">
          {report.ok ? "Readable in this theme and mode" : "Something here is below the floor"}
        </span>
        <span className="text-3xs text-fg-subtle">{open ? "Hide check" : "Show check"}</span>
      </button>
      {open && (
        <dl className="mt-2 space-y-1 border-t border-edge-subtle pt-2">
          {report.checks.map((c) => (
            <div key={c.label} className="flex items-baseline justify-between gap-2">
              <dt className="min-w-0 truncate text-3xs text-fg-subtle">
                {c.label}
                {c.repaired && <span className="ml-1 text-warn">clamped</span>}
              </dt>
              <dd
                className={cx(
                  "shrink-0 text-3xs tabular-nums",
                  c.ratio >= c.floor ? "text-success" : "text-danger",
                )}
              >
                {c.ratio === Infinity ? "—" : c.ratio.toFixed(2)}:1
                <span className="ml-1 text-fg-subtle">/ {c.floor}</span>
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2 pt-1 text-3xs text-fg-subtle">
            <dt>Solved channels ({report.mode})</dt>
            <dd className="flex items-center gap-1">
              {[report.channels.accent, report.channels.accent600, report.channels.accent700].map(
                (hex) => (
                  <span
                    key={hex}
                    title={hex}
                    className="h-3 w-3 rounded-sm border border-edge"
                    style={{ backgroundColor: hex }}
                  />
                ),
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
