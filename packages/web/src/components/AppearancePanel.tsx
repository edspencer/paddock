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
 * ── What is real ─────────────────────────────────────────────────────────────
 * Every swatch on the strip is painted with the colour that position actually
 * produces — `accentSwatches()` runs the same solve the app will run. The
 * theme cards are real scraps of their theme, cascaded by the same
 * `[data-theme]` blocks the app uses, not hand-picked preview hexes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { accentSwatches, type AccentReport } from "../lib/accent";
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
import { cx } from "./ui/cx";

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
function ThemeSwatch({ theme, dark }: { theme: ThemeId; dark: boolean }) {
  return (
    <div
      data-theme={theme}
      className={cx("overflow-hidden rounded-lg border border-edge", dark && "dark")}
    >
      <div className="flex items-center gap-2 bg-surface p-2">
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
  /** `true` inside the sidebar popover, where vertical room is scarce. */
  compact?: boolean;
  className?: string;
}

export function AppearancePanel({ compact = false, className }: AppearancePanelProps) {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [report, setReport] = useState<AccentReport | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  const commit = useCallback((next: Appearance) => {
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
        <div className={cx("mt-2 grid gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
          {THEMES.map((t) => {
            const selected = appearance.theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                onClick={() => commit({ ...appearance, theme: t.id })}
                className={cx(
                  "motion-fast rounded-xl border p-2 text-left transition-[border-color,box-shadow]",
                  "focus-visible:focus-ring",
                  selected
                    ? "border-accent-edge bg-accent-soft shadow-xs"
                    : "border-edge bg-surface-raised hover:border-edge-strong",
                )}
              >
                <ThemeSwatch theme={t.id} dark={dark} />
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-xs font-semibold text-fg">{t.label}</span>
                  {selected && <span className="text-3xs text-accent">in use</span>}
                </div>
                {!compact && (
                  <p className="mt-0.5 text-3xs leading-snug text-fg-subtle">{t.blurb}</p>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ----------------------------------------------------------- colour -- */}
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
                onClick={() => commit({ ...appearance, hue })}
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
            onClick={() => commit({ ...appearance, hue: null })}
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
                onClick={() => commit({ ...appearance, hue: n.hue })}
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

      {/* ------------------------------------------------------------- tint -- */}
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
              onClick={() => commit({ ...appearance, tint: t.level })}
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

      {/* ---------------------------------------------------------- readout -- */}
      {report && <ContrastReadout report={report} open={showChecks} onToggle={setShowChecks} />}
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
