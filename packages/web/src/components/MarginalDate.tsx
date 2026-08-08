/**
 * A date set in the margin — the `register` direction's one chronological
 * device, shared so that every surface which is a RECORD reads in the same
 * grammar.
 *
 * Two surfaces use it: the run register (`HistoryPane`) and the curated
 * `CHANGELOG.md` (`ChangelogRecord`). That is the point of extracting it. Those
 * two are the same kind of thing — an append-only account of what happened,
 * newest first — and the app has always rendered one as a table of chips and
 * the other as an undifferentiated wall of Markdown. Giving them one shared
 * gutter is what makes "Paddock is a system of record" a claim the interface
 * actually makes rather than one the README makes.
 *
 * The day is set in the display face at a size nothing else on the page uses,
 * the month in the mono eyebrow, and the year ONLY where it changes — a
 * structural device that repeats has to keep earning its place, and a year
 * stamped on every group would stop being information after the second one.
 */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export interface MarginalDateProps {
  date: Date;
  /** Print the year. Callers pass true only where the year CHANGES. */
  showYear?: boolean;
  /** Fallback text when there is no parseable date (an unheaded section). */
  fallback?: string;
}

export function MarginalDate({ date, showYear = false, fallback }: MarginalDateProps) {
  const valid = !Number.isNaN(date.getTime());
  if (!valid) {
    return (
      <div className="eyebrow pt-1 text-3xs leading-relaxed text-fg-subtle">{fallback ?? "—"}</div>
    );
  }
  return (
    <>
      <div className="marginal-date text-xl leading-none text-fg">{date.getDate()}</div>
      <div className="eyebrow mt-1 text-3xs text-fg-subtle">{MONTHS[date.getMonth()]}</div>
      {showYear && (
        <div className="folio mt-1 text-3xs text-fg-subtle/60">{date.getFullYear()}</div>
      )}
    </>
  );
}
