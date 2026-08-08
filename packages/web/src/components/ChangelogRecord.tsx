/**
 * `CHANGELOG.md`, rendered as a record rather than as a wall.
 *
 * The sweeper's contract is a newest-first file of `## YYYY-MM-DD` sections
 * (`enforceChangelogBudget` in packages/server/src/sweep.ts splits on exactly
 * that when it trims the file to its budget). Until now, that regex was the
 * ONLY code in the repo that understood the structure — the web app fetched the
 * file as one string and handed it to `<Markdown>`, so a project with three
 * months of curated history rendered as an unbroken scroll of `##` headings and
 * bullets. The structure was always there; nothing read it.
 *
 * So: parse the sections the sweeper already writes, and set each one against
 * the same marginal date the run register uses. Two surfaces, one chronological
 * grammar — and the date stops being a heading you scroll past and becomes the
 * thing you navigate by.
 *
 * Anything that does not parse falls straight through to plain Markdown. A
 * hand-edited changelog, a different date format, a file with no `##` sections
 * at all — none of those are errors, and none of them should lose their
 * content to a renderer that only knows one shape.
 */
import { useMemo } from "react";
import { Markdown } from "./Markdown";
import { MarginalDate } from "./MarginalDate";

interface Entry {
  /** The heading text with the leading `## ` stripped. */
  heading: string;
  /** Parsed from the heading when it is a date; null otherwise. */
  date: Date | null;
  /** Everything under the heading, up to the next one. */
  body: string;
}

/**
 * `2026-08-07` and `2026-08-07 — something` both parse; anything else does not.
 *
 * Deliberately strict: a heading like "Unreleased" or "v0.66.0" must NOT be
 * coerced into a date, because the margin would then print a day number that is
 * a lie. Those render with the heading text in the gutter instead.
 */
function headingDate(heading: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(heading.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseSections(source: string): Entry[] {
  const lines = source.split("\n");
  const entries: Entry[] = [];
  let current: Entry | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) {
      current.body = buffer.join("\n").trim();
      entries.push(current);
    }
    buffer = [];
  };

  for (const line of lines) {
    // A `## ` inside a fenced code block is content, not a heading.
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const heading = m[1]!.trim();
      current = { heading, date: headingDate(heading), body: "" };
    } else if (current) {
      buffer.push(line);
    }
    // Lines before the first `##` (the `# Changelog — slug` title) are dropped:
    // the section already has a title above it in the UI.
  }
  flush();
  return entries;
}

export function ChangelogRecord({ source }: { source: string }) {
  const entries = useMemo(() => parseSections(source), [source]);

  // Not the shape we know. Render it faithfully rather than losing it.
  if (entries.length === 0) {
    return (
      <div className="card">
        <Markdown>{source}</Markdown>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-edge bg-surface-raised px-4 py-2 shadow-xs">
      {entries.map((entry, i) => {
        const prev = entries[i - 1];
        const showYear =
          !!entry.date && (i === 0 || !prev?.date || prev.date.getFullYear() !== entry.date.getFullYear());
        return (
          <section
            key={`${entry.heading}-${i}`}
            className="flex gap-4 border-t border-edge-subtle py-4 first:border-t-0"
          >
            <div className="w-12 shrink-0 sm:w-14">
              <div className="sticky top-2">
                {entry.date ? (
                  <MarginalDate date={entry.date} showYear={showYear} />
                ) : (
                  <div className="eyebrow text-3xs leading-relaxed text-fg-subtle">
                    {entry.heading}
                  </div>
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              {entry.body ? (
                <Markdown>{entry.body}</Markdown>
              ) : (
                <p className="text-sm text-fg-subtle">Nothing recorded under this heading.</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
